const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3002;

const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');
const COSTS_FILE  = path.join(__dirname, 'data', 'daily-costs.json');

const COMMISSION_RATES = {
  '$1 SPANISH LEADS':   0.20,
  'AGED SPANISH LEADS': 0.20,
};
const DEFAULT_COMMISSION_RATE = 0.10;

const PRODUCTS = [
  'SPANISH IUL LEADS',
  'SPANISH FINAL EXPENSE LEADS',
  'SPANISH MORTGAGE PROTECTION LEADS',
  '$1 SPANISH LEADS',
  'AGED SPANISH LEADS',
  'VOLUME SPANISH IUL',
  'VOLUME SPANISH FINAL EXPENSE',
];

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

// costs[date] = { "PRODUCT": costPerLead, ... }
function calcProfit(order, costsForDate) {
  const cost = costsForDate?.[order.product];
  if (cost == null) return null;
  return (order.pricePerLead - cost) * order.quantity - order.replacements * cost - (order.commission || 0);
}

// Get costs for a date
app.get('/api/daily-cost', (req, res) => {
  const date  = req.query.date || new Date().toISOString().split('T')[0];
  const costs = readJSON(COSTS_FILE, {});
  res.json({ date, costs: costs[date] || {} });
});

// Set costs for a date — body: { date, costs: { PRODUCT: value, ... } }
// Empty string values remove that product's cost; missing keys leave existing untouched
app.post('/api/daily-cost', (req, res) => {
  const { date, costs: incoming } = req.body || {};
  if (!date || !incoming || typeof incoming !== 'object')
    return res.status(400).json({ error: 'date and costs object are required' });

  const all = readJSON(COSTS_FILE, {});
  if (!all[date]) all[date] = {};

  for (const [product, val] of Object.entries(incoming)) {
    if (!PRODUCTS.includes(product)) continue;
    if (val === '' || val == null) {
      delete all[date][product];
    } else {
      const n = parseFloat(val);
      if (!isNaN(n)) all[date][product] = n;
    }
  }

  if (Object.keys(all[date]).length === 0) delete all[date];
  writeJSON(COSTS_FILE, all);
  res.json({ success: true, date, costs: all[date] || {} });
});

// Dashboard
app.get('/api/dashboard', (req, res) => {
  const date        = req.query.date || new Date().toISOString().split('T')[0];
  const allOrders   = readJSON(ORDERS_FILE, []);
  const allCosts    = readJSON(COSTS_FILE, {});
  const costsForDay = allCosts[date] || {};
  const orders      = allOrders.filter(o => o.date === date);

  const enriched = orders.map(o => ({
    ...o,
    costPerLead: costsForDay[o.product] ?? null,
    netProfit:   calcProfit(o, costsForDay),
  }));

  const knownProfits = enriched.filter(o => o.netProfit != null);
  const totalProfit  = knownProfits.length ? knownProfits.reduce((s, o) => s + o.netProfit, 0) : null;

  const byProduct = {};
  for (const o of enriched) {
    if (!byProduct[o.product])
      byProduct[o.product] = { product: o.product, orders: 0, leads: 0, replacements: 0, profit: 0, hasAllCosts: true };
    byProduct[o.product].orders       += 1;
    byProduct[o.product].leads        += o.quantity;
    byProduct[o.product].replacements += o.replacements;
    if (o.netProfit != null) byProduct[o.product].profit += o.netProfit;
    else byProduct[o.product].hasAllCosts = false;
  }

  res.json({
    date,
    costs: costsForDay,
    totalProfit,
    totalOrders:       orders.length,
    totalLeads:        orders.reduce((s, o) => s + o.quantity, 0),
    totalReplacements: orders.reduce((s, o) => s + o.replacements, 0),
    orders:            enriched,
    byProduct:         Object.values(byProduct).sort((a, b) => b.profit - a.profit),
  });
});

// Add order
app.post('/api/orders', (req, res) => {
  const { date, product, clientName, quantity, pricePerLead, replacements, commission } = req.body || {};
  if (!date || !product || !quantity || pricePerLead == null)
    return res.status(400).json({ error: 'date, product, quantity and pricePerLead are required' });

  const qty        = parseInt(quantity);
  const price      = parseFloat(pricePerLead);
  const rate       = COMMISSION_RATES[String(product).trim()] ?? DEFAULT_COMMISSION_RATE;
  const defaultCom = parseFloat((price * qty * rate).toFixed(2));

  const order = {
    id:           Date.now(),
    date,
    product:      String(product).trim(),
    clientName:   String(clientName || '').trim(),
    quantity:     qty,
    pricePerLead: price,
    replacements: parseInt(replacements || 0),
    commission:   commission != null ? parseFloat(commission) : defaultCom,
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
  orders[idx] = {
    ...orders[idx],
    date:         b.date         ?? orders[idx].date,
    product:      b.product      ? String(b.product).trim()            : orders[idx].product,
    clientName:   b.clientName   != null ? String(b.clientName).trim() : orders[idx].clientName,
    quantity:     b.quantity     != null ? parseInt(b.quantity)        : orders[idx].quantity,
    pricePerLead: b.pricePerLead != null ? parseFloat(b.pricePerLead)  : orders[idx].pricePerLead,
    replacements: b.replacements != null ? parseInt(b.replacements)    : orders[idx].replacements,
    commission:   b.commission   != null ? parseFloat(b.commission)    : orders[idx].commission,
  };
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

app.listen(PORT, () => console.log(`LLL Tracking: http://localhost:${PORT}`));
