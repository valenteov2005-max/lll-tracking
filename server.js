const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;

const COMMISSION_RATES = { '$1 SPANISH LEADS': 0.20, 'AGED SPANISH LEADS': 0.20 };
const DEFAULT_COMMISSION_RATE = 0.10;
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
      id                     BIGINT PRIMARY KEY,
      client_name            TEXT    DEFAULT '',
      product                TEXT    NOT NULL,
      quantity               INTEGER NOT NULL,
      price_per_lead         DECIMAL NOT NULL,
      replacements           INTEGER DEFAULT 0,
      deliveries             JSONB   DEFAULT '{}',
      replacement_deliveries JSONB   DEFAULT '{}',
      created_at             TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Handle existing tables that predate these columns
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacements           INTEGER DEFAULT 0`);
  await pool.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS replacement_deliveries JSONB   DEFAULT '{}'`);
  console.log('PostgreSQL ready');
}

function rowToOrder(r) {
  return {
    id:                    Number(r.id),
    clientName:            r.client_name || '',
    product:               r.product,
    quantity:              Number(r.quantity),
    pricePerLead:          parseFloat(r.price_per_lead),
    replacements:          Number(r.replacements || 0),
    deliveries:            r.deliveries             || {},
    replacementDeliveries: r.replacement_deliveries || {},
    createdAt:             r.created_at,
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
      INSERT INTO orders
        (id, client_name, product, quantity, price_per_lead, replacements, deliveries, replacement_deliveries, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
      ON CONFLICT (id) DO UPDATE SET
        client_name            = EXCLUDED.client_name,
        product                = EXCLUDED.product,
        quantity               = EXCLUDED.quantity,
        price_per_lead         = EXCLUDED.price_per_lead,
        replacements           = EXCLUDED.replacements,
        deliveries             = EXCLUDED.deliveries,
        replacement_deliveries = EXCLUDED.replacement_deliveries
    `, [
      order.id, order.clientName, order.product, order.quantity, order.pricePerLead,
      order.replacements || 0,
      JSON.stringify(order.deliveries || {}),
      JSON.stringify(order.replacementDeliveries || {}),
      order.createdAt,
    ]);
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

async function updateReplacementDeliveries(id, replacementDeliveries) {
  if (USE_DB) {
    await pool.query('UPDATE orders SET replacement_deliveries = $1::jsonb WHERE id = $2', [JSON.stringify(replacementDeliveries), id]);
  } else {
    const orders = readJSON(ORDERS_FILE, []);
    const idx    = orders.findIndex(o => o.id === id);
    if (idx >= 0) { orders[idx].replacementDeliveries = replacementDeliveries; writeJSON(ORDERS_FILE, orders); }
  }
}

// ── Business logic ────────────────────────────────────────────────────────────

function calcDelivery(order, delivery) {
  const rate       = COMMISSION_RATES[order.product] ?? DEFAULT_COMMISSION_RATE;
  const revenue    = order.pricePerLead * delivery.leadsDelivered;
  const cost       = delivery.costPerLead * delivery.leadsDelivered;
  const commission = revenue * rate;
  return { ...delivery, commission, netProfit: revenue - cost - commission };
}

function enrichOrder(order, date) {
  const deliveries             = order.deliveries             || {};
  const replacementDeliveries  = order.replacementDeliveries  || {};

  const totalDelivered         = Object.values(deliveries).reduce((s, d) => s + d.leadsDelivered, 0);
  const totalReplFulfilled     = Object.values(replacementDeliveries).reduce((s, d) => s + d.count, 0);

  const todayRaw               = deliveries[date]            || null;
  const todayRepl              = replacementDeliveries[date] || null;
  const todayReplacementLoss   = todayRepl ? todayRepl.count * todayRepl.costPerLead : 0;

  return {
    ...order,
    totalDelivered,
    totalReplFulfilled,
    remaining:            Math.max(0, order.quantity - totalDelivered),
    fulfilled:            totalDelivered >= order.quantity,
    todayDelivery:        todayRaw  ? calcDelivery(order, todayRaw) : null,
    todayReplDelivery:    todayRepl ? { ...todayRepl, loss: todayReplacementLoss } : null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/api/dashboard', async (req, res) => {
  const date   = req.query.date || new Date().toISOString().split('T')[0];
  const orders = (await getAllOrders()).map(o => enrichOrder(o, date));

  const withDel  = orders.filter(o => o.todayDelivery);
  const withRepl = orders.filter(o => o.todayReplDelivery);

  const totalDeliveryProfit  = withDel.reduce((s, o) => s + o.todayDelivery.netProfit, 0);
  const totalReplacementLoss = withRepl.reduce((s, o) => s + o.todayReplDelivery.loss, 0);

  res.json({
    date,
    totalNetProfit:      totalDeliveryProfit - totalReplacementLoss,
    totalRevenue:        withDel.reduce((s, o) => s + o.todayDelivery.leadsDelivered * o.pricePerLead, 0),
    totalCommission:     withDel.reduce((s, o) => s + o.todayDelivery.commission, 0),
    totalLeads:          withDel.reduce((s, o) => s + o.todayDelivery.leadsDelivered, 0),
    totalReplacementLoss,
    orders,
  });
});

// Create order
app.post('/api/orders', async (req, res) => {
  const { clientName, product, quantity, pricePerLead, replacements } = req.body || {};
  if (!product || !quantity || pricePerLead == null)
    return res.status(400).json({ error: 'product, quantity and pricePerLead are required' });

  const order = {
    id:                   Date.now(),
    clientName:           String(clientName || '').trim(),
    product:              String(product).trim(),
    quantity:             parseInt(quantity),
    pricePerLead:         parseFloat(pricePerLead),
    replacements:         parseInt(replacements || 0),
    deliveries:           {},
    replacementDeliveries:{},
    createdAt:            new Date().toISOString(),
  };
  await upsertOrder(order);
  res.json({ success: true, order });
});

// Edit order
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

// Delete order
app.delete('/api/orders/:id', async (req, res) => {
  await deleteOrderById(parseInt(req.params.id));
  res.json({ success: true });
});

// Log regular delivery
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

// Delete regular delivery
app.delete('/api/orders/:id/delivery/:date', async (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = await getAllOrders();
  const order  = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  delete (order.deliveries || {})[req.params.date];
  await updateDeliveries(id, order.deliveries || {});
  res.json({ success: true });
});

// Log replacement delivery (pure loss)
app.post('/api/orders/:id/replacement-delivery', async (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = await getAllOrders();
  const order  = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Not found' });

  const { date, count, costPerLead } = req.body || {};
  if (!date || count == null || costPerLead == null)
    return res.status(400).json({ error: 'date, count and costPerLead are required' });

  if (!order.replacementDeliveries) order.replacementDeliveries = {};
  order.replacementDeliveries[date] = { count: parseInt(count), costPerLead: parseFloat(costPerLead) };
  await updateReplacementDeliveries(id, order.replacementDeliveries);
  res.json({ success: true, order: enrichOrder(order, date) });
});

// Delete replacement delivery
app.delete('/api/orders/:id/replacement-delivery/:date', async (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = await getAllOrders();
  const order  = orders.find(o => o.id === id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  delete (order.replacementDeliveries || {})[req.params.date];
  await updateReplacementDeliveries(id, order.replacementDeliveries || {});
  res.json({ success: true });
});

// ── Start ─────────────────────────────────────────────────────────────────────

initDB().then(() => {
  app.listen(PORT, () => console.log(`LLL Tracking: http://localhost:${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err.message);
  process.exit(1);
});
