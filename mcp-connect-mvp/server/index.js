import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import Stripe from 'stripe';
import { authMiddleware, createToken, hashPassword, verifyPassword } from './lib/auth.js';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;
const stripeSecret = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

app.use(cors());
app.use(express.json());

const planDefinitions = [
  { id: 'free', name: 'Free', price: 0, period: 'month', limits: { servers: 2, messagesPerDay: 30 } },
  { id: 'pro-month', name: 'Pro Monthly', price: 2, period: 'month', limits: { servers: 'unlimited', messagesPerDay: 'unlimited' } },
  { id: 'pro-year', name: 'Pro Yearly', price: 20, period: 'year', limits: { servers: 'unlimited', messagesPerDay: 'unlimited' } },
  { id: 'lifetime', name: 'Lifetime', price: 99, period: 'once', limits: { servers: 'unlimited', messagesPerDay: 'unlimited' } },
];

const sampleCatalog = [
  { id: 'filesystem', name: 'Filesystem', description: 'Local file operations', icon: '📁', status: 'available', transport: 'stdio' },
  { id: 'github', name: 'GitHub', description: 'Repository search and issues', icon: '🐙', status: 'available', transport: 'http' },
  { id: 'postgres', name: 'PostgreSQL', description: 'Database tools', icon: '🐘', status: 'coming-soon', transport: 'sse' },
];

const broadcastClients = new Set();

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/plans', (_req, res) => {
  res.json({ plans: planDefinitions });
});

app.get('/mcp/catalog', async (_req, res) => {
  res.json({ catalog: sampleCatalog });
});

app.get('/usage', authMiddleware, async (_req, res) => {
  res.json({ serversUsed: 0, messagesToday: 0, plan: 'free' });
});

app.post('/auth/signup', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const id = randomUUID();
  const hashed = await hashPassword(password);
  if (pool) {
    await pool.query(
      'INSERT INTO users (id, email, password_hash, plan_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [id, email, hashed, 'free'],
    );
  }
  const token = createToken({ userId: id, email, plan: 'free' });
  res.json({ token, user: { id, email, plan: 'free' } });
});

app.post('/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (!pool) {
    const token = createToken({ userId: 'demo', email, plan: 'free' });
    return res.json({ token, user: { id: 'demo', email, plan: 'free' } });
  }
  const result = await pool.query('SELECT id, password_hash, plan_id FROM users WHERE email=$1 LIMIT 1', [email]);
  const row = result.rows[0];
  if (!row) return res.status(401).json({ error: 'invalid credentials' });
  const valid = await verifyPassword(password, row.password_hash);
  if (!valid) return res.status(401).json({ error: 'invalid credentials' });
  const token = createToken({ userId: row.id, email, plan: row.plan_id });
  res.json({ token, user: { id: row.id, email, plan: row.plan_id } });
});

app.post('/billing/checkout', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(501).json({ error: 'Stripe not configured' });
  const { planId } = req.body || {};
  const plan = planDefinitions.find((p) => p.id === planId);
  if (!plan) return res.status(400).json({ error: 'invalid plan' });
  const session = await stripe.checkout.sessions.create({
    mode: plan.period === 'once' ? 'payment' : 'subscription',
    line_items: [
      {
        price_data: {
          currency: 'usd',
          unit_amount: plan.price * 100,
          product_data: { name: plan.name },
          recurring: plan.period === 'once' ? undefined : { interval: plan.period === 'month' ? 'month' : 'year' },
        },
        quantity: 1,
      },
    ],
    success_url: process.env.BILLING_SUCCESS_URL || 'http://localhost:5173/success',
    cancel_url: process.env.BILLING_CANCEL_URL || 'http://localhost:5173/cancel',
  });
  res.json({ url: session.url });
});

app.post('/billing/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  // Stub: validate signature and update user plan in DB
  res.json({ received: true });
});

app.get('/events/catalog', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write('retry: 10000\n\n');
  const client = res;
  broadcastClients.add(client);
  req.on('close', () => broadcastClients.delete(client));
});

function broadcastCatalogUpdate() {
  broadcastClients.forEach((client) => {
    client.write(`event: catalog\n`);
    client.write(`data: ${JSON.stringify({ catalog: sampleCatalog })}\n\n`);
  });
}

app.post('/admin/catalog', (req, res) => {
  const { id, name, description, icon, status } = req.body || {};
  if (!id || !name) return res.status(400).json({ error: 'id and name required' });
  const existing = sampleCatalog.findIndex((c) => c.id === id);
  const entry = { id, name, description, icon, status: status || 'available' };
  if (existing >= 0) sampleCatalog[existing] = entry;
  else sampleCatalog.push(entry);
  broadcastCatalogUpdate();
  res.json({ ok: true, catalog: sampleCatalog });
});

app.listen(port, () => {
  console.log(`API running on http://localhost:${port}`);
});
