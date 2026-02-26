'use strict';

/**
 * check-inventory Lambda
 *
 * Simulates a real inventory service with:
 *   - Product-specific behaviour (latency, stock levels, pricing)
 *   - Random stock-out scenarios for certain SKUs
 *   - Intentional slow responses on PROD-003 to generate p99 latency signals
 *
 * X-Ray subsegments expose internal steps for APM analysis.
 */

const AWSXRay = require('aws-xray-sdk-core');

// ── Product catalog ─────────────────────────────────────────────────────────
const CATALOG = {
  'PROD-001': { name: 'Wireless Headphones', price: 79.99,  stock: 500, latencyMs: [20,  80]  },
  'PROD-002': { name: 'Mechanical Keyboard', price: 149.99, stock: 50,  latencyMs: [30,  150] },
  'PROD-003': { name: 'USB-C Hub',           price: 39.99,  stock: 200, latencyMs: [300, 800] }, // intentionally slow
  'PROD-004': { name: 'Monitor Stand',       price: 59.99,  stock: 0,   latencyMs: [10,  50]  }, // always OOS
  'PROD-005': { name: 'Webcam HD',           price: 89.99,  stock: 25,  latencyMs: [50,  200] },
};

const DEFAULT_PRODUCT = { name: 'Generic Product', price: 19.99, stock: 100, latencyMs: [10, 60] };

exports.handler = async (event) => {
  const { productId, quantity = 1 } = event;

  console.log(JSON.stringify({ level: 'INFO', action: 'check-inventory', productId, quantity }));

  const segment = AWSXRay.getSegment();
  segment.addAnnotation('productId', productId);
  segment.addAnnotation('requestedQty', quantity);

  // ── Step 1: Catalog lookup ────────────────────────────────────────────────
  const lookupSub = segment.addNewSubsegment('catalog-lookup');
  const product = CATALOG[productId] || DEFAULT_PRODUCT;
  lookupSub.addAnnotation('productName', product.name);
  lookupSub.addAnnotation('catalogPrice', product.price);
  lookupSub.close();

  // ── Step 2: Simulate DB/cache latency for this product ───────────────────
  const [minMs, maxMs] = product.latencyMs;
  const simulatedLatency = minMs + Math.floor(Math.random() * (maxMs - minMs));

  const dbSub = segment.addNewSubsegment('inventory-db-query');
  dbSub.addAnnotation('simulatedLatencyMs', simulatedLatency);
  await sleep(simulatedLatency);
  dbSub.close();

  // ── Step 3: Stock check ──────────────────────────────────────────────────
  const stockSub = segment.addNewSubsegment('stock-availability');

  // PROD-002: 30% random stock-out to generate interesting traces
  let effectiveStock = product.stock;
  if (productId === 'PROD-002' && Math.random() < 0.30) {
    effectiveStock = 0;
    stockSub.addAnnotation('scenario', 'random_stockout');
  }

  const available = effectiveStock >= quantity;
  const availableQty = effectiveStock;

  stockSub.addAnnotation('available', available);
  stockSub.addAnnotation('effectiveStock', effectiveStock);
  stockSub.close();

  segment.addAnnotation('available', available);

  const result = {
    productId,
    productName: product.name,
    available,
    availableQty,
    requestedQty: quantity,
    price: product.price,
    checkedAt: new Date().toISOString(),
  };

  console.log(JSON.stringify({ level: 'INFO', action: 'inventory-result', ...result }));
  return result;
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
