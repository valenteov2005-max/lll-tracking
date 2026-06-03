const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;

const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');

const COMMISSION_RATES = {
  '$1 SPANISH LEADS':   0.20,
  'AGED SPANISH LEADS': 0.20,
};
const DEFAULT_COMMISSION_RATE = 0.10;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function calcDelivery(order, delivery) {
  const rate       = COMMISSION_RATES[order.product] ?? DEFAULT_COMMISSION_RATE;
  const revenue    = order.pricePerLead * delivery.leadsDelivered;
  const cost       = delivery.costPerLead * delivery.leadsDelivered;
  const commission = revenue * rate;
  return { ...delivery, commission, netProfit: revenue - cost - commission };
}

function enrichOrder(order, date) {
  const deliveries     = order.deliveries || {};
  const totalDelivered = Object.values(deliveries).reduce((s, d) => s + d.leadsDelivered, 0);
  const todayRaw       = deliveries[date] || null;
  return {
    ...order,
    totalDelivered,
    remaining:     Math.max(0, order.quantity - totalDelivered),
    fulfilled:     totalDelivered >= order.quantity,
    todayDelivery: todayRaw ? calcDelivery(order, todayRaw) : null,
  };
}

// Dashboard for a selected date
app.get('/api/dashboard', (req, res) => {
  const date   = req.query.date || new Date().toISOString().split('T')[0];
  const orders = readJSON(ORDERS_FILE, []).map(o => enrichOrder(o, date));

  const withDelivery = orders.filter(o => o.todayDelivery);
  res.json({
    date,
    totalNetProfit:  withDelivery.reduce((s, o) => s + o.todayDelivery.netProfit, 0),
    totalRevenue:    withDelivery.reduce((s, o) => s + o.todayDelivery.leadsDelivered * o.pricePerLead, 0),
    totalCommission: withDelivery.reduce((s, o) => s + o.todayDelivery.commission, 0),
    totalLeads:      withDelivery.reduce((s, o) => s + o.todayDelivery.leadsDelivered, 0),
    orders,
  });
});

// Create order
app.post('/api/orders', (req, res) => {
  const { clientName, product, quantity, pricePerLead } = req.body || {};
  if (!product || !quantity || pricePerLead == null)
    return res.status(400).json({ error: 'product, quantity and pricePerLead are required' });

  const order = {
    id:           Date.now(),
    clientName:   String(clientName || '').trim(),
    product:      String(product).trim(),
    quantity:     parseInt(quantity),
    pricePerLead: parseFloat(pricePerLead),
    deliveries:   {},
    createdAt:    new Date().toISOString(),
  };

  const orders = readJSON(ORDERS_FILE, []);
  orders.push(order);
  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true, order });
});

// Edit order
app.put('/api/orders/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = readJSON(ORDERS_FILE, []);
  const idx    = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const b = req.body || {};
  if (b.clientName   != null) orders[idx].clientName   = String(b.clientName).trim();
  if (b.product)               orders[idx].product      = String(b.product).trim();
  if (b.quantity     != null) orders[idx].quantity      = parseInt(b.quantity);
  if (b.pricePerLead != null) orders[idx].pricePerLead  = parseFloat(b.pricePerLead);
  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true, order: orders[idx] });
});

// Delete order
app.delete('/api/orders/:id', (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = readJSON(ORDERS_FILE, []);
  const idx    = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  orders.splice(idx, 1);
  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true });
});

// Log or update a daily delivery for an order
app.post('/api/orders/:id/delivery', (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = readJSON(ORDERS_FILE, []);
  const idx    = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { date, leadsDelivered, costPerLead } = req.body || {};
  if (!date || leadsDelivered == null || costPerLead == null)
    return res.status(400).json({ error: 'date, leadsDelivered and costPerLead are required' });

  if (!orders[idx].deliveries) orders[idx].deliveries = {};
  orders[idx].deliveries[date] = {
    leadsDelivered: parseInt(leadsDelivered),
    costPerLead:    parseFloat(costPerLead),
  };

  writeJSON(ORDERS_FILE, orders);
  const enriched = enrichOrder(orders[idx], date);
  res.json({ success: true, order: enriched });
});

// Delete a daily delivery entry
app.delete('/api/orders/:id/delivery/:date', (req, res) => {
  const id     = parseInt(req.params.id);
  const orders = readJSON(ORDERS_FILE, []);
  const idx    = orders.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  delete (orders[idx].deliveries || {})[req.params.date];
  writeJSON(ORDERS_FILE, orders);
  res.json({ success: true });
});

app.listen(PORT, () => console.log(`LLL Tracking: http://localhost:${PORT}`));
