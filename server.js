const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;

const COMMISSION_RATES = { '$1 SPANISH LEADS': 0.20, 'AGED SPANISH LEADS': 0.20 };
const DEFAULT_COMMISSION_RATE = 0.10;
const COMMISSION_CUTOFF    = '2026-06-21'; // from this date: 15% of gross profit instead of 10% of revenue
const MEDIA_BUYER_CUTOFF   = '2026-07-01'; // from this date: media buyer gets same commission as salesman
const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Storage ───────────────────────────────────────────────────────────────────

const USE_DB = !!process.env.DATABASE_URL;
let pool;

if (USE_DB) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
}

async function initDB() {
  if (!USE_DB) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id            BIGINT  PRIMARY KEY,
      client_name   TEXT    DEFAULT '',
      product       TEXT    NOT NULL,
      quantity      INTEGER NOT NULL,
      price_per_lead DECIMAL NOT NULL,
      replacements  INTEGER DEFAULT 0,
      deliveries    JSONB   DEFAULT '{}',
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacements INTEGER DEFAULT 0`);
  console.log('PostgreSQL ready');
}

function rowToOrder(r) {
  return {
    id:           Number(r.id),
    clientName:   r.client_name || '',
    product:      r.product,
    quantity:     Number(r.quantity),
    pricePerLead: parseFloat(r.price_per_lead),
    replacements: Number(r.replacements || 0),
    deliveries:   r.deliveries || {},
    createdAt:    r.created_at,
  };
}

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function getAllOrders() {
  if (USE_DB) {
    const { rows } = await pool.query('SELECT * FROM orders ORDER BY created_at ASC');
    return rows.map(rowToOrder);
  }
  return readJSON(ORDERS_FILE, []);
}

async function upsertOrder(order) {
  if (USE_DB) {
    await pool.query(`
      INSERT INTO orders (id, client_name, product, quantity, price_per_lead, replacements, deliveries, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
      ON CONFLICT (id) DO UPDATE SET
        client_name    = EXCLUDED.client_name,
        product        = EXCLUDED.product,
        quantity       = EXCLUDED.quantity,
        price_per_lead = EXCLUDED.price_per_lead,
        replacements   = EXCLUDED.replacements,
        deliveries     = EXCLUDED.deliveries
    `, [order.id, order.clientName, order.product, order.quantity, order.pricePerLead,
        order.replacements || 0, JSON.stringify(order.deliveries || {}), order.createdAt]);
  } else {
    const orders = readJSON(ORDERS_FILE, []);
    const idx    = orders.findIndex(o => o.id === order.id);
    if (idx >= 0) orders[idx] = order; else orders.push(order);
    writeJSON(ORDERS_FILE, orders);
  }
}

async function deleteOrderById(id) {
  if (USE_DB) {
    await pool.query('DELETE FROM orders WHERE id = $1', [id]);
  } else {
    const orders = readJSON(ORDERS_FILE, []);
    writeJSON(ORDERS_FILE, orders.filter(o => o.id !== id));
  }
}

async function updateDeliveries(id, deliveries) {
  if (USE_DB) {
    await pool.query('UPDATE orders SET deliveries = $1::jsonb WHERE id = $2', [JSON.stringify(deliveries), id]);
  } else {
    const orders = readJSON(ORDERS_FILE, []);
    const idx    = orders.findIndex(o => o.id === id);
    if (idx >= 0) { orders[idx].deliveries = deliveries; writeJSON(ORDERS_FILE, orders); }
  }
}

// ── Business logic ────────────────────────────────────────────────────────────

// prevTotal = cumulative leads delivered across all dates BEFORE this one
function calcDelivery(order, delivery, prevTotal, date) {
  const qty  = order.quantity;
  const repl = order.replacements || 0;
  const leads = delivery.leadsDelivered;

  // Split today's leads into paid vs replacement
  const todayPaid = Math.max(0, Math.min(leads, qty - prevTotal));
  const prevRepl  = Math.max(0, prevTotal - qty);
  const todayRepl = Math.max(0, Math.min(leads - todayPaid, repl - prevRepl));

  const revenue         = order.pricePerLead * todayPaid;
  const costTotal       = delivery.costPerLead * (todayPaid + todayRepl);
  const replacementLoss = delivery.costPerLead * todayRepl;

  const fixedRate = COMMISSION_RATES[order.product];

  // Salesman commission
  let commission;
  if (fixedRate != null) {
    commission = revenue * fixedRate;
  } else if (date >= COMMISSION_CUTOFF) {
    commission = Math.max(0, (revenue - costTotal) * 0.15);
  } else {
    commission = revenue * DEFAULT_COMMISSION_RATE;
  }

  // Media buyer commission: same rates as salesman, starts July 1
  let mediaBuyerCommission = 0;
  if (date >= MEDIA_BUYER_CUTOFF) {
    mediaBuyerCommission = fixedRate != null
      ? revenue * fixedRate
      : Math.max(0, (revenue - costTotal) * 0.15);
  }

  return {
    ...delivery,
    todayPaid,
    todayRepl,
    revenue,
    commission,
    mediaBuyerCommission,
    replacementLoss,
    netProfit: revenue - costTotal - commission - mediaBuyerCommission,
  };
}

function enrichOrder(order, date) {
  const deliveries  = order.deliveries || {};
  const sortedDates = Object.keys(deliveries).sort();

  let prevTotal       = 0;
  let deliveredBefore = 0;
  let todayDelivery   = null;

  for (const d of sortedDates) {
    if (d === date) {
      deliveredBefore = prevTotal;
      todayDelivery   = calcDelivery(order, deliveries[d], prevTotal, date);
    }
    prevTotal += deliveries[d].leadsDelivered;
  }

  const totalExpected = order.quantity + (order.replacements || 0);

  return {
    ...order,
    totalDelivered:  prevTotal,
    deliveredBefore,
    totalExpected,
    remaining:  Math.max(0, totalExpected - prevTotal),
    fulfilled:  prevTotal >= totalExpected,
    todayDelivery,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  const date   = req.query.date || new Date().toISOString().split('T')[0];
  const orders = (await getAllOrders()).map(o => enrichOrder(o, date));

  const withDel = orders.filter(o => o.todayDelivery);
  res.json({
    date,
    totalNetProfit:            withDel.reduce((s, o) => s + o.todayDelivery.netProfit, 0),
    totalRevenue:              withDel.reduce((s, o) => s + o.todayDelivery.revenue, 0),
    totalCommission:           withDel.reduce((s, o) => s + o.todayDelivery.commission, 0),
    totalMediaBuyerCommission: withDel.reduce((s, o) => s + o.todayDelivery.mediaBuyerCommission, 0),
    totalLeads:                withDel.reduce((s, o) => s + o.todayDelivery.leadsDelivered, 0),
    totalReplacementLoss:withDel.reduce((s, o) => s + o.todayDelivery.replacementLoss, 0),
    orders,
  });
});

app.post('/api/orders', async (req, res) => {
  const { clientName, product, quantity, pricePerLead, replacements } = req.body || {};
  if (!product || !quantity || pricePerLead == null)
    return res.status(400).json({ error: 'product, quantity and pricePerLead are required' });

  const order = {
    id:           Date.now(),
    clientName:   String(clientName || '').trim(),
    product:      String(product).trim(),
    quantity:     parseInt(quantity),
    pricePerLead: parseFloat(pricePerLead),
    replacements: parseInt(replacements || 0),
    deliveries:   {},
    createdAt:    new Date().toISOString(),
  };
  await upsertOrder(order);
  res.json({ success: true, order });
});

app.put('/api/orders/:id', async (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = await getAllOrders();
  const order  = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  if (b.clientName   != null) order.clientName   = String(b.clientName).trim();
  if (b.product)               order.product      = String(b.product).trim();
  if (b.quantity     != null) order.quantity      = parseInt(b.quantity);
  if (b.pricePerLead != null) order.pricePerLead  = parseFloat(b.pricePerLead);
  if (b.replacements != null) order.replacements  = parseInt(b.replacements);
  await upsertOrder(order);
  res.json({ success: true, order });
});

app.delete('/api/orders/:id', async (req, res) => {
  await deleteOrderById(parseInt(req.params.id));
  res.json({ success: true });
});

app.post('/api/orders/:id/delivery', async (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = await getAllOrders();
  const order  = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Not found' });

  const { date, leadsDelivered, costPerLead } = req.body || {};
  if (!date || leadsDelivered == null || costPerLead == null)
    return res.status(400).json({ error: 'date, leadsDelivered and costPerLead are required' });

  if (!order.deliveries) order.deliveries = {};
  order.deliveries[date] = { leadsDelivered: parseInt(leadsDelivered), costPerLead: parseFloat(costPerLead) };
  await updateDeliveries(id, order.deliveries);
  res.json({ success: true, order: enrichOrder(order, date) });
});

app.delete('/api/orders/:id/delivery/:date', async (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = await getAllOrders();
  const order  = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  delete (order.deliveries || {})[req.params.date];
  await updateDeliveries(id, order.deliveries || {});
  res.json({ success: true });
});

initDB().then(() => {
  app.listen(PORT, () => console.log(`LLL Tracking: http://localhost:${PORT}`));
}).catch(err => { console.error('DB init failed:', err.message); process.exit(1); });
