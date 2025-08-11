# TaxlotIQ — PnL & Tax-Lots API

Turns raw trade histories into realized/unrealized PnL and open tax lots (FIFO/LIFO/HIFO/Specific-ID).
Crypto, stocks, FX; optional wash-sale flagging; corporate actions; tax-ready reports.

## Quick Start (local)
```bash
npm ci
npm run build
API_KEYS=demo_key node dist/server.js
# or with Docker:
# docker build -t taxlotiq .
# docker run -p 8080:8080 -e API_KEYS=demo_key taxlotiq
```

**Base URL (local):** `http://localhost:8080/v1`  
**Ping:** `GET /v1/ping` → `{ ok: true }`

## Endpoints
- `POST /v1/portfolios` — create/update portfolio
- `POST /v1/trades:ingest` — idempotent trade ingest
- `POST /v1/pnl:realized` — realized PnL (FIFO/LIFO/HIFO/SpecID)
- `POST /v1/pnl:unrealized` — unrealized PnL (provide marks)
- `POST /v1/lots:open` — list open lots
- `POST /v1/reports:tax` — (stub in MVP) period tax report
- `POST /v1/corporate-actions` — (stub in MVP) splits/symbol changes
- `POST /v1/transfers` — (stub in MVP) deposits/withdrawals

Auth header: `x-api-key: <YOUR_KEY>`

## Deploy on Render
- Build: `npm ci && npm run build`
- Start: `node dist/server.js`
- Env: `API_KEYS=demo_key`
- After deploy, update your OpenAPI `servers:` URL to your Render URL.

## Deploy on Fly.io
```bash
fly launch --name taxlotiq --dockerfile Dockerfile --no-deploy
fly secrets set API_KEYS=demo_key
fly deploy
```

## OpenAPI Spec
See `taxlotiq-openapi.yaml`. Import to RapidAPI.

## License
MIT — see `LICENSE`.
