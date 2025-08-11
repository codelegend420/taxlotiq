// src/server.ts
import express, { Request, Response, NextFunction } from 'express';
import bodyParser from 'body-parser';

// --- Simple API key auth middleware ---
const KEYSET = new Set((process.env.API_KEYS || 'demo_key')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean));

function requireKey(req: Request, res: Response, next: NextFunction) {
  const key = req.header('x-api-key') || '';
  if (!KEYSET.has(key)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// --- Types ---
interface Trade {
  client_trade_id: string;
  timestamp: string; // ISO 8601
  symbol: string;    // e.g., BTC-USD
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  fee?: number;
  fee_currency?: string;
}

type Method = 'FIFO' | 'LIFO' | 'HIFO' | 'SPECID';

type Lot = {
  lot_id: string;           // client_trade_id of the BUY
  symbol: string;
  qty_open: number;         // remaining units
  unit_cost: number;        // price + allocated per-unit fee
  acquired_at: number;      // epoch ms
};

// --- App setup ---
const app = express();
app.use(bodyParser.json({ limit: '2mb' }));

// Public health check (no auth for convenience)
app.get('/v1/ping', (_req: Request, res: Response) => {
  res.json({ ok: true, ts: Date.now() });
});

// Require API key for everything else
app.use((req, res, next) => {
  if (req.path === '/v1/ping') return next();
  return requireKey(req, res, next);
});

// In-memory DB (replace with Postgres/Redis in production)
const DB: Record<string, { base: string; trades: Trade[]; lots: Lot[]; }> = {};

const byTime = (a: Trade, b: Trade) =>
  new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();

app.post('/v1/portfolios', (req: Request, res: Response) => {
  const { portfolio_id, base_currency } = req.body || {};
  if (!portfolio_id || !base_currency) {
    return res.status(400).json({ error: 'Missing portfolio_id/base_currency' });
  }
  if (!DB[portfolio_id]) DB[portfolio_id] = { base: base_currency, trades: [], lots: [] };
  else DB[portfolio_id].base = base_currency;
  return res.json({ portfolio_id, updated: true });
});

app.post('/v1/trades:ingest', (req: Request, res: Response) => {
  const { portfolio_id, trades } = req.body as { portfolio_id: string; trades: Trade[] };
  if (!portfolio_id || !Array.isArray(trades)) {
    return res.status(400).json({ error: 'Missing portfolio_id or trades' });
  }
  const port = DB[portfolio_id];
  if (!port) return res.status(404).json({ error: 'Portfolio not found' });

  const existingIds = new Set(port.trades.map(t => t.client_trade_id));
  const accepted: string[] = [], duplicates: string[] = [];

  for (const t of trades) {
    if (!t || !t.client_trade_id || !t.timestamp || !t.symbol || !t.side || !t.qty || !t.price) {
      return res.status(400).json({ error: 'Invalid trade payload' });
    }
    if (existingIds.has(t.client_trade_id)) { duplicates.push(t.client_trade_id); continue; }
    port.trades.push(t);
    accepted.push(t.client_trade_id);
  }
  port.trades.sort(byTime);
  port.lots = buildLots(port.trades);
  return res.json({ accepted, duplicates, total_trades: port.trades.length, open_lots: port.lots.length });
});

function buildLots(trades: Trade[]): Lot[] {
  const lots: Lot[] = [];
  for (const t of trades) {
    if (t.side === 'BUY') {
      lots.push({
        lot_id: t.client_trade_id,
        symbol: t.symbol,
        qty_open: t.qty,
        unit_cost: (t.price + ((t.fee || 0) / Math.max(t.qty, 1))),
        acquired_at: new Date(t.timestamp).getTime()
      });
    } else {
      // SELL: consume FIFO baseline (method is handled when querying PnL endpoints)
      let remaining = t.qty;
      const fifo = lots.filter(l => l.symbol === t.symbol).sort((a, b) => a.acquired_at - b.acquired_at);
      for (const lot of fifo) {
        if (remaining <= 0) break;
        const take = Math.min(lot.qty_open, remaining);
        lot.qty_open -= take;
        remaining -= take;
      }
    }
  }
  return lots.filter(l => l.qty_open > 1e-12);
}

function pickOrder(method: Method, symbolLots: Lot[]): Lot[] {
  const arr = [...symbolLots];
  if (method === 'FIFO') return arr.sort((a, b) => a.acquired_at - b.acquired_at);
  if (method === 'LIFO') return arr.sort((a, b) => b.acquired_at - a.acquired_at);
  if (method === 'HIFO') return arr.sort((a, b) => b.unit_cost - a.unit_cost);
  return arr; // SPECID handled separately if you add allocations
}

app.post('/v1/pnl:realized', (req: Request, res: Response) => {
  const { portfolio_id, from, to, method } = req.body as { portfolio_id: string; from: string; to: string; method: Method };
  const port = DB[portfolio_id];
  if (!port) return res.status(404).json({ error: 'Portfolio not found' });
  if (!from || !to || !method) return res.status(400).json({ error: 'Missing from/to/method' });

  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const trades = port.trades.filter(t => new Date(t.timestamp).getTime() <= end).sort(byTime);
  const buys: Lot[] = [];
  const realized: any[] = [];

  const pushBuy = (t: Trade) => buys.push({
    lot_id: t.client_trade_id,
    symbol: t.symbol,
    qty_open: t.qty,
    unit_cost: (t.price + ((t.fee || 0) / Math.max(t.qty, 1))),
    acquired_at: new Date(t.timestamp).getTime()
  });

  const closeLots = (symbol: string, qty: number, sellPrice: number, sellId: string, sellTime: number) => {
    let remaining = qty;
    let pnl = 0, proceeds = 0, cost = 0;
    const closed: any[] = [];
    const order = pickOrder(method, buys.filter(l => l.symbol === symbol && l.qty_open > 0));
    for (const lot of order) {
      if (remaining <= 0) break;
      const take = Math.min(lot.qty_open, remaining);
      lot.qty_open -= take;
      remaining -= take;
      proceeds += take * sellPrice;
      cost += take * lot.unit_cost;
      pnl += take * (sellPrice - lot.unit_cost);
      closed.push({
        buy_client_trade_id: lot.lot_id,
        sell_client_trade_id: sellId,
        qty: take,
        buy_price: lot.unit_cost,
        sell_price: sellPrice,
        holding_period_days: Math.round((sellTime - lot.acquired_at) / (1000 * 60 * 60 * 24)),
        long_term: (sellTime - lot.acquired_at) >= 365 * 24 * 60 * 60 * 1000
      });
    }
    return { pnl, proceeds, cost, closed };
  };

  for (const t of trades) {
    const ts = new Date(t.timestamp).getTime();
    if (t.side === 'BUY') { pushBuy(t); continue; }
    const { pnl, proceeds, cost, closed } = closeLots(t.symbol, t.qty, t.price, t.client_trade_id, ts);
    if (pnl !== 0 || proceeds !== 0 || cost !== 0) {
      realized.push({ symbol: t.symbol, proceeds, cost_basis: cost, fees: t.fee || 0, pnl, lots_closed: closed });
    }
  }

  // Filter realized to window [from, to]
  const out = realized.filter(r => {
    const anyClose = r.lots_closed.find((c: any) => {
      const sell = trades.find(t => t.client_trade_id === c.sell_client_trade_id);
      const tss = sell ? new Date(sell.timestamp).getTime() : 0;
      return tss >= start && tss <= end;
    });
    return Boolean(anyClose);
  });

  return res.json({ portfolio_id, method, currency: port.base, realized: out });
});

app.post('/v1/lots:open', (req: Request, res: Response) => {
  const { portfolio_id } = req.body || {};
  const port = DB[portfolio_id];
  if (!port) return res.status(404).json({ error: 'Portfolio not found' });
  return res.json({ portfolio_id, open_lots: port.lots });
});

app.post('/v1/pnl:unrealized', (req: Request, res: Response) => {
  const { portfolio_id, method, marks } = req.body || {};
  const port = DB[portfolio_id];
  if (!port) return res.status(404).json({ error: 'Portfolio not found' });
  const priceMap = new Map<string, number>((marks || []).map((m: any) => [m.symbol, m.price]));
  const lots = pickOrder(method || 'FIFO', port.lots);
  const bySym: Record<string, Lot[]> = {};
  lots.forEach(l => { if (!bySym[l.symbol]) bySym[l.symbol] = []; bySym[l.symbol].push(l); });
  const rows = Object.entries(bySym).map(([sym, arr]) => {
    const qty = arr.reduce((s, l) => s + l.qty_open, 0);
    const cost = arr.reduce((s, l) => s + l.qty_open * l.unit_cost, 0);
    const px = priceMap.get(sym) ?? null;
    const value = px ? qty * px : null;
    const pnl = px ? (value! - cost) : null;
    return { symbol: sym, qty, wac: qty ? cost / qty : 0, mark: px, value, cost_basis: cost, unrealized: pnl };
  });
  return res.json({ portfolio_id, method: method || 'FIFO', currency: port.base, positions: rows });
});

// --- Start server ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`TaxlotIQ API listening on :${PORT}`);
});
