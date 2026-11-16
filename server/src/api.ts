import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { env, COUNTRIES, VEHICLES, quote, isLatLng } from './config.js';
import { notify, removeLive } from './hub.js';
import { HttpError, createOrder, acceptOrder, advanceOrder, cancelOrder, orderView, activeOrderFor } from './orders.js';

type Authed = Request & { user: { id: string; role: string } };
const h = (fn: (req: any, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res).catch(next);

const auth = (...roles: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const u = jwt.verify(token, env.jwtSecret) as { id: string; role: string };
    if (roles.length && !roles.includes(u.role)) return next(new HttpError(403, 'forbidden'));
    (req as Authed).user = u;
    next();
  } catch { next(new HttpError(401, 'unauthorized')); }
};

const sign = (u: { id: string; role: string }) => jwt.sign({ id: u.id, role: u.role }, env.jwtSecret, { expiresIn: '30d' });
const normPhone = (s: unknown) => (typeof s === 'string' ? s.replace(/[^\d+]/g, '') : '');
const str = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

async function profile(id: string) {
  const { rows } = await pool.query(
    `SELECT u.id, u.role, u.name, u.phone, u.lang, c.vehicle, c.plate, c.status AS courier_status, c.deliveries,
            s.store_name, s.lat AS store_lat, s.lng AS store_lng
     FROM users u LEFT JOIN couriers c ON c.user_id = u.id LEFT JOIN stores s ON s.user_id = u.id WHERE u.id = $1`, [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id, role: r.role, name: r.name, phone: r.phone, lang: r.lang,
    courier: r.role === 'courier' ? { vehicle: r.vehicle, plate: r.plate, status: r.courier_status, deliveries: r.deliveries } : undefined,
    store: r.role === 'store' ? { name: r.store_name, lat: r.store_lat, lng: r.store_lng } : undefined,
  };
}

export const api = Router();
const authLimit = rateLimit({ windowMs: 10 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });

api.get('/config', (_req, res) => {
  res.json({
    demo: env.demo, vehicles: VEHICLES, vapidKey: env.vapidPublic || null,
    countries: Object.values(COUNTRIES).map((c) => ({ code: c.code, currency: c.currency, center: c.center })),
  });
});

api.post('/auth/register', authLimit, h(async (req, res) => {
  const b = req.body ?? {};
  const role = ['client', 'store', 'courier'].includes(b.role) ? b.role : null;
  const name = str(b.name, 60), phone = normPhone(b.phone), password = typeof b.password === 'string' ? b.password : '';
  if (!role || name.length < 2) throw new HttpError(400, 'invalid_name');
  if (phone.replace(/\D/g, '').length < 8) throw new HttpError(400, 'invalid_phone');
  if (password.length < 6) throw new HttpError(400, 'weak_password');
  if (role === 'courier' && !VEHICLES.includes(b.vehicle)) throw new HttpError(400, 'vehicle_required');
  if (role === 'store' && str(b.storeName, 80).length < 2) throw new HttpError(400, 'store_name_required');
  const taken = await pool.query(`SELECT 1 FROM users WHERE phone = $1`, [phone]);
  if (taken.rows.length) throw new HttpError(409, 'phone_taken');

  const id = randomUUID();
  const lang = ['pt', 'fr', 'en'].includes(b.lang) ? b.lang : 'pt';
  await pool.query(`INSERT INTO users (id, role, name, phone, password_hash, lang) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, role, name, phone, await bcrypt.hash(password, 10), lang]);
  if (role === 'courier')
    await pool.query(`INSERT INTO couriers (user_id, vehicle, plate) VALUES ($1,$2,$3)`, [id, b.vehicle, str(b.plate, 16) || null]);
  if (role === 'store') {
    const at = isLatLng(b.storeAt) ? b.storeAt : { lat: null, lng: null };
    await pool.query(`INSERT INTO stores (user_id, store_name, lat, lng) VALUES ($1,$2,$3,$4)`, [id, str(b.storeName, 80), at.lat, at.lng]);
  }
  res.json({ token: sign({ id, role }), user: await profile(id) });
}));

api.post('/auth/login', authLimit, h(async (req, res) => {
  const phone = normPhone(req.body?.phone);
  const { rows } = await pool.query(`SELECT id, role, password_hash FROM users WHERE phone = $1`, [phone]);
  const ok = rows[0] && (await bcrypt.compare(String(req.body?.password ?? ''), rows[0].password_hash).catch(() => false));
  if (!ok) throw new HttpError(401, 'bad_credentials');
  res.json({ token: sign(rows[0]), user: await profile(rows[0].id) });
}));

api.get('/me', auth(), h(async (req: Authed, res) => {
  const user = await profile(req.user.id);
  if (!user) throw new HttpError(401, 'unauthorized');
  res.json({ user, order: await activeOrderFor(req.user) });
}));

api.post('/me/lang', auth(), h(async (req: Authed, res) => {
  if (!['pt', 'fr', 'en'].includes(req.body?.lang)) throw new HttpError(400, 'bad_lang');
  await pool.query(`UPDATE users SET lang = $2 WHERE id = $1`, [req.user.id, req.body.lang]);
  res.json({ ok: true });
}));

api.post('/quote', h(async (req, res) => {
  const { pickup, dropoff, vehicle } = req.body ?? {};
  if (!isLatLng(pickup) || !isLatLng(dropoff)) throw new HttpError(400, 'bad_location');
  const q = quote(pickup, dropoff, VEHICLES.includes(vehicle) ? vehicle : null);
  if (!q) throw new HttpError(400, 'out_of_area');
  res.json(q);
}));

// ---------- Pedidos ----------

api.post('/orders', auth('client', 'store'), h(async (req: Authed, res) => res.json(await createOrder(req.user, req.body ?? {}))));

api.get('/orders', auth(), h(async (req: Authed, res) => {
  const col = req.user.role === 'courier' ? 'courier_id' : 'created_by';
  const { rows } = await pool.query(`SELECT id FROM orders WHERE ${col} = $1 ORDER BY created_at DESC LIMIT 30`, [req.user.id]);
  res.json(await Promise.all(rows.map((r) => orderView(r.id))));
}));

api.get('/orders/:id', auth(), h(async (req: Authed, res) => {
  const o = await orderView(req.params.id);
  if (!o || (o.createdBy !== req.user.id && o.courier?.id !== req.user.id)) throw new HttpError(404, 'not_found');
  res.json(o);
}));

api.post('/orders/:id/accept', auth('courier'), h(async (req: Authed, res) => res.json(await acceptOrder(req.params.id, req.user.id))));
api.post('/orders/:id/status', auth('courier'), h(async (req: Authed, res) =>
  res.json(await advanceOrder(req.params.id, req.user.id, req.body?.status))));
api.post('/orders/:id/cancel', auth(), h(async (req: Authed, res) => res.json(await cancelOrder(req.params.id, req.user))));

api.get('/track/:code', h(async (req, res) => {
  const { rows } = await pool.query(`SELECT id FROM orders WHERE code = $1`, [String(req.params.code).toUpperCase()]);
  if (!rows[0]) throw new HttpError(404, 'not_found');
  res.json(await orderView(rows[0].id, { publicOnly: true }));
}));

// ---------- Notificações ----------

api.get('/notifications', auth(), h(async (req: Authed, res) => {
  const { rows } = await pool.query(
    `SELECT id, type, order_id, code, status, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40`,
    [req.user.id]);
  res.json(rows.map((n) => ({ id: n.id, type: n.type, orderId: n.order_id, code: n.code, status: n.status, read: n.is_read, createdAt: n.created_at })));
}));

api.post('/notifications/read', auth(), h(async (req: Authed, res) => {
  await pool.query(`UPDATE notifications SET is_read = true WHERE user_id = $1`, [req.user.id]);
  res.json({ ok: true });
}));

api.post('/push/subscribe', auth(), h(async (req: Authed, res) => {
  const sub = req.body;
  if (typeof sub?.endpoint !== 'string' || !sub.keys) throw new HttpError(400, 'bad_subscription');
  await pool.query(`DELETE FROM push_subs WHERE endpoint = $1`, [sub.endpoint]);
  await pool.query(`INSERT INTO push_subs (endpoint, user_id, sub) VALUES ($1,$2,$3)`, [sub.endpoint, req.user.id, JSON.stringify(sub)]);
  res.json({ ok: true });
}));

// ---------- Administração ----------

api.get('/admin/couriers', auth('admin'), h(async (req, res) => {
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.phone, u.created_at, c.vehicle, c.plate, c.status, c.deliveries
     FROM couriers c JOIN users u ON u.id = c.user_id WHERE c.status = $1 AND u.phone NOT LIKE 'demo-%'
     ORDER BY u.created_at DESC LIMIT 100`, [status]);
  res.json(rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, createdAt: r.created_at, vehicle: r.vehicle, plate: r.plate, status: r.status, deliveries: r.deliveries })));
}));

api.post('/admin/couriers/:id/:action', auth('admin'), h(async (req, res) => {
  const status = req.params.action === 'approve' ? 'approved' : req.params.action === 'reject' ? 'rejected' : null;
  if (!status) throw new HttpError(400, 'bad_action');
  const r = await pool.query(`UPDATE couriers SET status = $2 WHERE user_id = $1 RETURNING user_id`, [req.params.id, status]);
  if (!r.rows.length) throw new HttpError(404, 'not_found');
  if (status === 'rejected') removeLive(req.params.id);
  await notify(req.params.id, { type: `courier_${status}` });
  res.json({ ok: true });
}));

api.use((_req, _res, next) => next(new HttpError(404, 'not_found')));
api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_json' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});
