'use strict';

/**
 * get-orders Lambda
 *
 * GET /orders           – list recent orders (scan, up to 50)
 * GET /orders/{orderId} – fetch a single order by ID
 *
 * Optional query params:
 *   ?status=PENDING|CREATED|FAILED   – filter by order status (uses GSI)
 *   ?limit=N                          – page size (default 20, max 50)
 */

const AWSXRay = require('aws-xray-sdk-core');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  ScanCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

const ddbRawClient = AWSXRay.captureAWSv3Client(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const docClient = DynamoDBDocumentClient.from(ddbRawClient);

exports.handler = async (event) => {
  const { pathParameters, queryStringParameters } = event;
  const orderId = pathParameters?.orderId;
  const status = queryStringParameters?.status;
  const limit = Math.min(parseInt(queryStringParameters?.limit || '20', 10), 50);

  const segment = AWSXRay.getSegment();
  segment.addAnnotation('queryType', orderId ? 'single' : 'list');
  if (status) segment.addAnnotation('statusFilter', status);

  // ── Single order lookup ────────────────────────────────────────────────
  if (orderId) {
    const getSub = segment.addNewSubsegment('get-order-by-id');
    getSub.addAnnotation('orderId', orderId);
    let result;
    try {
      result = await docClient.send(
        new GetCommand({
          TableName: process.env.TABLE_NAME,
          Key: { orderId },
        })
      );
    } catch (err) {
      getSub.addError(err);
      getSub.close();
      console.error(JSON.stringify({ level: 'ERROR', step: 'get-order', err: err.message }));
      return jsonResponse(500, { error: 'Failed to fetch order' });
    }
    getSub.addAnnotation('found', !!result.Item);
    getSub.close();

    if (!result.Item) {
      return jsonResponse(404, { error: `Order ${orderId} not found` });
    }
    return jsonResponse(200, result.Item);
  }

  // ── List orders ───────────────────────────────────────────────────────
  // Use GSI if status filter is provided; otherwise scan
  let items = [];
  if (status) {
    const querySub = segment.addNewSubsegment('query-orders-by-status');
    querySub.addAnnotation('status', status);
    try {
      const result = await docClient.send(
        new QueryCommand({
          TableName: process.env.TABLE_NAME,
          IndexName: 'status-createdAt-index',
          KeyConditionExpression: '#s = :status',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':status': status },
          ScanIndexForward: false, // newest first
          Limit: limit,
        })
      );
      items = result.Items || [];
      querySub.addAnnotation('itemCount', items.length);
    } catch (err) {
      querySub.addError(err);
      querySub.close();
      return jsonResponse(500, { error: 'Query failed' });
    }
    querySub.close();
  } else {
    const scanSub = segment.addNewSubsegment('scan-orders');
    try {
      const result = await docClient.send(
        new ScanCommand({
          TableName: process.env.TABLE_NAME,
          Limit: limit,
        })
      );
      items = result.Items || [];
      // Sort newest-first in memory (scan doesn't guarantee order)
      items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      scanSub.addAnnotation('itemCount', items.length);
      scanSub.addAnnotation('scannedCount', result.ScannedCount || 0);
    } catch (err) {
      scanSub.addError(err);
      scanSub.close();
      return jsonResponse(500, { error: 'Scan failed' });
    }
    scanSub.close();
  }

  segment.addAnnotation('resultCount', items.length);
  return jsonResponse(200, { count: items.length, orders: items });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
