# CloudWatch APM Demo — Distributed Tracing with AWS X-Ray

A serverless demo app that shows **end-to-end distributed tracing** across multiple
Lambda functions, with DynamoDB and API Gateway, all visible in the CloudWatch
X-Ray console, service map, and custom dashboard.

## Architecture

```
                          ┌─────────────────────────────────────────────────┐
                          │              AWS Lambda  (X-Ray Active Tracing)  │
  Client / Load           │                                                  │
  Generator               │  ┌─────────────────┐                            │
     │                    │  │  create-order    │──── invoke ────►check-     │
     ▼                    │  │  (orchestrator)  │                inventory   │
  API Gateway ───────────►│  │                 │──── PutItem ──►DynamoDB     │
  (X-Ray tracing)         │  │                 │──── async ────►send-        │
                          │  └─────────────────┘                notification │
  GET /orders             │  ┌─────────────────┐                            │
  GET /orders/{id} ──────►│  │   get-orders     │──── Scan/Query─►DynamoDB   │
  GET /health    ────────►│  │   health-check   │                            │
                          └─────────────────────────────────────────────────┘
```

### Lambda Functions

| Function | Trigger | What it demonstrates |
|---|---|---|
| `create-order` | `POST /orders` | Orchestration, annotations, subsegments, partial failures |
| `check-inventory` | Sync Lambda invoke | Variable latency by product, random stock-outs |
| `send-notification` | Async Lambda invoke | Fault injection (email timeout, SMS failures) |
| `get-orders` | `GET /orders[/{id}]` | DynamoDB Scan/Query tracing, GSI |
| `health-check` | `GET /health` | Baseline healthy node in the service map |

### APM Signals Generated

| Signal | Where to see it |
|---|---|
| Distributed traces | X-Ray → Traces |
| Service dependency map | X-Ray → Service Map |
| Lambda latency p50/p99 | CloudWatch Dashboard |
| DynamoDB read/write units | CloudWatch Dashboard |
| Error rate (email timeout, OOS) | X-Ray Trace Groups / CloudWatch Alarms |
| Custom annotations | X-Ray → Search Traces (`Annotation.orderId`, `Annotation.orderStatus`) |

---

## Prerequisites

### Install required tools (macOS via Homebrew)

```bash
# AWS CLI v2
brew install awscli

# AWS SAM CLI >= 1.90
brew tap aws/tap
brew install aws-sam-cli

# Node.js 18+ (local testing only)
brew install node@18
```

### Verify installations

```bash
# Required tools
aws --version         # AWS CLI v2
sam --version         # AWS SAM CLI >= 1.90
node --version        # Node.js 18+ (local testing only)
```

### Configure AWS credentials

```bash
# Create a named profile for this demo
aws configure --profile cloudwatch-demo
# Prompts for: AWS Access Key ID, Secret Access Key, Region (e.g. us-east-1), Output format (json)

# Export the profile so all aws/sam commands pick it up automatically
export AWS_PROFILE=cloudwatch-demo
export AWS_REGION=us-east-1   # optional — override default region

# Verify credentials are working
aws sts get-caller-identity
```

> Add `export AWS_PROFILE=cloudwatch-demo` to your shell profile (`~/.zshrc` or `~/.bashrc`) to make it permanent.

---

## Quick Start — Deploy to AWS

### 1. Build

```bash
cd apm/
sam build
```

### 2. Deploy (first time)

```bash
sam deploy --guided
```

When prompted:
- **Stack Name**: `cloudwatch-apm-demo` (or any name you like)
- **AWS Region**: `us-east-1` (or your preferred region)
- **Confirm changeset**: `Y`
- **Save arguments to samconfig.toml**: `Y`

After deploy you will see outputs like:

```
Key         ApiUrl
Value       https://abc123xyz.execute-api.us-east-1.amazonaws.com/prod

Key         XRayConsoleUrl
Value       https://us-east-1.console.aws.amazon.com/xray/home?region=us-east-1#/service-map

Key         CloudWatchDashboardUrl
Value       https://us-east-1.console.aws.amazon.com/cloudwatch/home?...
```

### 3. Subsequent deploys

```bash
sam build && sam deploy
```

---

## Testing

### Manual curl

```bash
export API_URL="https://<your-api-id>.execute-api.us-east-1.amazonaws.com/prod"

# Health check
curl "${API_URL}/health"

# Create an order (happy path)
curl -X POST "${API_URL}/orders" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"CUST-0042","productId":"PROD-001","quantity":2}'

# Create a slow order (PROD-003 has 300–800ms inventory latency)
curl -X POST "${API_URL}/orders" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"CUST-0099","productId":"PROD-003","quantity":1}'

# Trigger out-of-stock (PROD-004 has zero stock)
curl -X POST "${API_URL}/orders" \
  -H "Content-Type: application/json" \
  -d '{"customerId":"CUST-0001","productId":"PROD-004","quantity":1}'

# List orders
curl "${API_URL}/orders?limit=20"

# List by status
curl "${API_URL}/orders?status=PENDING"
```

### Load generator (generates rich APM data)

```bash
# 200 requests, 5 parallel — takes ~1–2 minutes
./scripts/load-generator.sh "${API_URL}" 200 5
```

The script sends a **mix of scenarios**:

| Product | Behaviour |
|---|---|
| PROD-001 | Fast (20–80ms), always in stock |
| PROD-002 | Medium (30–150ms), 30% random OOS |
| PROD-003 | **Slow (300–800ms)** inventory lookup |
| PROD-004 | Always OOS → 409 response |
| PROD-005 | Medium, sometimes low stock |
| CUST-VIP-* | Triggers SMS notification path |

### Local testing with SAM

```bash
# Invoke a single function locally (uses the events/ directory)
sam local invoke CreateOrderFunction --event events/create-order.json
sam local invoke CreateOrderFunction --event events/create-order-slow.json
sam local invoke CreateOrderFunction --event events/create-order-oos.json

# Start local API (needs Docker)
sam local start-api
curl -X POST http://127.0.0.1:3000/orders \
  -H "Content-Type: application/json" \
  -d '{"productId":"PROD-001","quantity":1}'
```

> **Note**: X-Ray traces are not emitted during `sam local` invocations — deploy
> to AWS to see real traces.

---

## Viewing Traces in AWS Console

### X-Ray Service Map

1. Open the **XRayConsoleUrl** output from `sam deploy`
2. You should see a graph like:

```
[API Gateway] → [create-order] → [check-inventory]
                             ↘ → [DynamoDB]
                             ↘ → [send-notification]
[API Gateway] → [get-orders]  → [DynamoDB]
```

Nodes are colour-coded: **green** = OK, **orange** = throttled/slow, **red** = errors.

### Trace Search

Go to **X-Ray → Traces** and filter by:

```
# All failed orders
Annotation.orderStatus = "OUT_OF_STOCK"

# Slow PROD-003 traces
Annotation.productId = "PROD-003"

# A specific order
Annotation.orderId = "your-order-uuid-here"

# Traces with errors
Error = true
```

### CloudWatch Dashboard

Open the **CloudWatchDashboardUrl** output to see:
- Lambda invocations, errors, and duration (p50/p99)
- API Gateway latency and 4xx/5xx rates
- DynamoDB read/write capacity units consumed

---

## Product Catalogue

| Product ID | Name | Stock | Inventory Latency | Special Behaviour |
|---|---|---|---|---|
| PROD-001 | Wireless Headphones | 500 | 20–80ms | Always succeeds |
| PROD-002 | Mechanical Keyboard | 50 | 30–150ms | 30% random OOS |
| PROD-003 | USB-C Hub | 200 | **300–800ms** | High-latency traces |
| PROD-004 | Monitor Stand | **0** | 10–50ms | Always OOS → 409 |
| PROD-005 | Webcam HD | 25 | 50–200ms | Low stock |

---

## Tear Down

```bash
sam delete --stack-name cloudwatch-apm-demo
```

This removes all Lambda functions, DynamoDB table, API Gateway, IAM roles, and
the CloudWatch dashboard.

---

## Project Structure

```
apm/
├── template.yaml               # SAM / CloudFormation template
├── samconfig.toml              # Default deploy parameters
├── events/                     # Test event payloads for sam local invoke
│   ├── create-order.json
│   ├── create-order-vip.json
│   ├── create-order-slow.json  # PROD-003 (high latency)
│   ├── create-order-oos.json   # PROD-004 (always OOS)
│   └── get-orders.json
├── scripts/
│   └── load-generator.sh       # Bash script to generate mixed load
└── src/
    ├── create-order/           # Orchestrator (POST /orders)
    │   ├── index.js
    │   └── package.json
    ├── check-inventory/        # Inventory service (sync Lambda invoke)
    │   ├── index.js
    │   └── package.json
    ├── send-notification/      # Notification service (async Lambda invoke)
    │   ├── index.js
    │   └── package.json
    ├── get-orders/             # Read service (GET /orders)
    │   ├── index.js
    │   └── package.json
    └── health-check/           # Health endpoint (GET /health)
        ├── index.js
        └── package.json
```
