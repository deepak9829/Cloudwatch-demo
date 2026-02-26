'use strict';

exports.handler = async () => ({
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    status: 'healthy',
    service: 'cloudwatch-apm-demo',
    timestamp: new Date().toISOString(),
  }),
});
