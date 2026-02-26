'use strict';

/**
 * send-notification Lambda
 *
 * Simulates dispatching an order-confirmation notification via:
 *   - Email channel  (always attempted)
 *   - SMS channel    (attempted only if customerId starts with "CUST-VIP-")
 *
 * Fault injection:
 *   - 8%  chance: email provider timeout   → recorded as error in X-Ray
 *   - 5%  chance: SMS gateway unavailable  → recorded as error, email still succeeds
 *   - 2%  chance: full notification failure → throws, Lambda marks invocation as error
 *
 * These faults generate the "error" and "fault" nodes in the X-Ray service map.
 */

const AWSXRay = require('aws-xray-sdk-core');

exports.handler = async (event) => {
  const { orderId, customerId = 'CUST-0000', order = {} } = event;

  console.log(JSON.stringify({ level: 'INFO', action: 'send-notification', orderId, customerId }));

  const segment = AWSXRay.getSegment();
  segment.addAnnotation('orderId', orderId);
  segment.addAnnotation('customerId', customerId);
  segment.addAnnotation('channel', customerId.startsWith('CUST-VIP-') ? 'email+sms' : 'email');

  // ── Step 1: Prepare notification payload ─────────────────────────────────
  const prepSub = segment.addNewSubsegment('prepare-payload');
  const payload = {
    to: `${customerId.toLowerCase()}@example.com`,
    subject: `Order Confirmation – ${orderId}`,
    body: buildEmailBody(order),
    orderId,
    totalAmount: order.totalAmount,
  };
  prepSub.addMetadata('emailPayload', { to: payload.to, subject: payload.subject });
  await sleep(10 + Math.random() * 20); // template rendering
  prepSub.close();

  // ── Step 2: Send email ────────────────────────────────────────────────────
  const emailSub = segment.addNewSubsegment('send-email');
  try {
    if (Math.random() < 0.02) {
      // 2% – catastrophic failure (full function error)
      throw new Error('Notification service is completely down');
    }
    if (Math.random() < 0.08) {
      // 8% – email provider timeout
      await sleep(5000); // simulate long timeout
      const timeoutErr = new Error('Email provider timeout after 5000ms');
      emailSub.addError(timeoutErr);
      emailSub.addAnnotation('result', 'timeout');
      emailSub.close();
      console.error(JSON.stringify({ level: 'ERROR', step: 'send-email', err: timeoutErr.message }));
      // Degraded success – notification not sent but order is valid
      segment.addAnnotation('emailSent', false);
      return { status: 'PARTIAL', orderId, emailSent: false, reason: 'email_timeout' };
    }
    await sleep(100 + Math.random() * 300); // normal send latency
    emailSub.addAnnotation('result', 'sent');
    emailSub.addMetadata('messageId', `msg-${Date.now()}`);
  } catch (err) {
    emailSub.addError(err);
    emailSub.close();
    throw err; // propagate – Lambda will mark invocation as failed
  }
  emailSub.close();

  // ── Step 3: SMS (VIP customers only) ────────────────────────────────────
  if (customerId.startsWith('CUST-VIP-')) {
    const smsSub = segment.addNewSubsegment('send-sms');
    try {
      if (Math.random() < 0.05) {
        const smsErr = new Error('SMS gateway unavailable');
        smsSub.addError(smsErr);
        smsSub.addAnnotation('result', 'failed');
        console.warn(JSON.stringify({ level: 'WARN', step: 'send-sms', err: smsErr.message }));
      } else {
        await sleep(80 + Math.random() * 120);
        smsSub.addAnnotation('result', 'sent');
      }
    } finally {
      smsSub.close();
    }
  }

  segment.addAnnotation('emailSent', true);
  console.log(JSON.stringify({ level: 'INFO', action: 'notification-sent', orderId }));
  return { status: 'OK', orderId, emailSent: true };
};

function buildEmailBody(order) {
  return [
    `Thank you for your order!`,
    `Order ID  : ${order.orderId || 'N/A'}`,
    `Product   : ${order.productId || 'N/A'}  x${order.quantity || 1}`,
    `Total     : $${order.totalAmount || '0.00'}`,
    `Status    : ${order.status || 'PENDING'}`,
    ``,
    `We will notify you once your order ships.`,
  ].join('\n');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
