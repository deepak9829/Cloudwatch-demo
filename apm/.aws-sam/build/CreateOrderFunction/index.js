'use strict';

/**
 * create-order Lambda
 *
 * Orchestrator function that:
 *   1. Validates the incoming order request
 *   2. Calls check-inventory (sync) to confirm availability + price
 *   3. Persists the order to DynamoDB
 *   4. Invokes send-notification (async / fire-and-forget)
 *
 * X-Ray traces show the full call chain and timing for each step.
 */

const AWSXRay = require('aws-xray-sdk-core');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { v4: uuidv4 } = require('uuid');

// Wrap AWS SDK v3 clients so every call creates an X-Ray subsegment automatically
const ddbRawClient = AWSXRay.captureAWSv3Client(
  new DynamoDBClient({ region: process.env.AWS_REGION })
);
const docClient = DynamoDBDocumentClient.from(ddbRawClient);
const lambdaClient = AWSXRay.captureAWSv3Client(
  new LambdaClient({ region: process.env.AWS_REGION })
);

exports.handler = async (event) => {
  const orderId = uuidv4();
  let body = {};

  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const {
    customerId = `CUST-${Math.floor(Math.random() * 1000).toString().padStart(4, '0')}`,
    productId = 'PROD-001',
    quantity = 1,
  } = body;

  console.log(JSON.stringify({ level: 'INFO', orderId, customerId, productId, quantity }));

  // ── X-Ray: add searchable annotations to the root segment ──────────────
  const segment = AWSXRay.getSegment();
  segment.addAnnotation('orderId', orderId);
  segment.addAnnotation('customerId', customerId);
  segment.addAnnotation('productId', productId);

  // ── Step 1: Input validation ────────────────────────────────────────────
  const validSub = segment.addNewSubsegment('input-validation');
  try {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      validSub.addAnnotation('result', 'invalid_quantity');
      validSub.close();
      return jsonResponse(400, { error: 'quantity must be an integer between 1 and 100' });
    }
    if (!productId.startsWith('PROD-')) {
      validSub.addAnnotation('result', 'invalid_product_id');
      validSub.close();
      return jsonResponse(400, { error: 'productId must start with PROD-' });
    }
    validSub.addAnnotation('result', 'pass');
  } finally {
    validSub.close();
  }

  // ── Step 2: Inventory check (synchronous Lambda invoke) ─────────────────
  let inventoryResult;
  const invSub = segment.addNewSubsegment('inventory-check');
  try {
    const invokeRes = await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.CHECK_INVENTORY_FUNCTION,
        InvocationType: 'RequestResponse',
        Payload: JSON.stringify({ productId, quantity }),
      })
    );

    const raw = Buffer.from(invokeRes.Payload).toString();
    inventoryResult = JSON.parse(raw);

    invSub.addAnnotation('available', inventoryResult.available);
    invSub.addAnnotation('price', inventoryResult.price || 0);
    invSub.addMetadata('inventoryDetail', inventoryResult);
  } catch (err) {
    invSub.addError(err);
    invSub.close();
    console.error(JSON.stringify({ level: 'ERROR', step: 'inventory-check', err: err.message }));
    return jsonResponse(503, { error: 'Inventory service unavailable, please retry' });
  }
  invSub.close();

  if (!inventoryResult.available) {
    segment.addAnnotation('orderStatus', 'OUT_OF_STOCK');
    return jsonResponse(409, {
      error: 'Product out of stock',
      productId,
      requestedQty: quantity,
      availableQty: inventoryResult.availableQty,
    });
  }

  // ── Step 3: Persist order to DynamoDB ───────────────────────────────────
  const order = {
    orderId,
    customerId,
    productId,
    quantity,
    unitPrice: inventoryResult.price,
    totalAmount: +(inventoryResult.price * quantity).toFixed(2),
    status: 'PENDING',
    createdAt: new Date().toISOString(),
  };

  const dbSub = segment.addNewSubsegment('save-to-dynamodb');
  try {
    await docClient.send(
      new PutCommand({
        TableName: process.env.TABLE_NAME,
        Item: order,
        ConditionExpression: 'attribute_not_exists(orderId)', // idempotency guard
      })
    );
    dbSub.addAnnotation('result', 'saved');
  } catch (err) {
    dbSub.addError(err);
    dbSub.close();
    console.error(JSON.stringify({ level: 'ERROR', step: 'save-to-dynamodb', err: err.message }));
    return jsonResponse(500, { error: 'Failed to persist order' });
  }
  dbSub.close();

  // ── Step 4: Fire notification (async / event invocation) ────────────────
  const notifSub = segment.addNewSubsegment('trigger-notification');
  try {
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: process.env.SEND_NOTIFICATION_FUNCTION,
        InvocationType: 'Event', // async – don't wait for result
        Payload: JSON.stringify({ orderId, customerId, order }),
      })
    );
    notifSub.addAnnotation('notificationTriggered', true);
  } catch (err) {
    // Non-critical – log but don't fail the order
    notifSub.addError(err);
    console.warn(JSON.stringify({ level: 'WARN', step: 'trigger-notification', err: err.message }));
  }
  notifSub.close();

  segment.addAnnotation('orderStatus', 'CREATED');
  console.log(JSON.stringify({ level: 'INFO', message: 'Order created', orderId, totalAmount: order.totalAmount }));

  return jsonResponse(201, { message: 'Order created successfully', order });
};

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
