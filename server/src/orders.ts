// Ciclo de vida do pedido: criação, despacho para entregadores próximos, aceite e avanço de status.
import { randomUUID, randomInt } from 'node:crypto';
import { pool } from './db.js';
import { io, online, notify, setBusy, freeCouriersNear } from './hub.js';
import { quote, isLatLng, VEHICLES, type Vehicle } from './config.js';

export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

export type Status = 'requested' | 'accepted' | 'at_pickup' | 'picked_up' | 'delivered' | 'cancelled' | 'expired';
const NEXT: Partial<Record<Status, Status>> = { accepted: 'at_pickup', at_pickup: 'picked_up', picked_up: 'delivered' };
const OPEN: Status[] = ['requested', 'accepted', 'at_pickup', 'picked_up'];

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from({ length: 6 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
const clean = (s: unknown, max: number) => (typeof s === 'string' ? s.trim().slice(0, max) : '');

export async function orderView(id: string, opts: { publicOnly?: boolean } = {}) {
  const { rows } = await pool.query(
    `SELECT o.*, u.name AS courier_name, u.phone AS courier_phone, c.vehicle AS courier_vehicle, c.plate AS courier_plate,
            r.name AS creator_name, r.phone AS creator_phone
     FROM orders o JOIN users r ON r.id = o.created_by
     LEFT JOIN users u ON u.id = o.courier_id LEFT JOIN couriers c ON c.user_id = o.courier_id
     WHERE o.id = $1`, [id]);
  const o = rows[0];
  if (!o) return null;
  const view: any = {
    id: o.id, code: o.code, status: o.status as Status, country: o.country,
    pickup: { label: o.pickup_label, lat: o.pickup_lat, lng: o.pickup_lng },
    dropoff: { label: o.dropoff_label, lat: o.dropoff_lat, lng: o.dropoff_lng },
    item: o.item, distanceKm: o.distance_km, price: o.price, currency: o.currency,
    vehiclePref: o.vehicle_pref, createdAt: o.created_at, updatedAt: o.updated_at,
    courier: o.courier_id
      ? { id: o.courier_id, name: String(o.courier_name).split(' ')[0], vehicle: o.courier_vehicle, plate: o.courier_plate }
      : null,
  };
  if (!opts.publicOnly) {
    view.createdBy = o.created_by;
    view.requesterRole = o.requester_role;
    view.recipientName = o.recipient_name;
    view.recipientPhone = o.recipient_phone;
    // Com quem o entregador fala na entrega: o destinatário informado pela loja ou o próprio cliente.
    view.contact = { name: o.recipient_name ?? o.creator_name, phone: o.recipient_phone ?? o.creator_phone };
    if (view.courier) view.courier.phone = o.courier_phone;
  }
  return view;
}

async function broadcast(id: string) {
  const full = await orderView(id);
  if (!full) return null;
  // A sala do pedido pode ter visitantes (link público): recebe só a versão sem dados pessoais.
  io.to(`order:${id}`).emit('order:update', await orderView(id, { publicOnly: true }));
  io.to(`user:${full.createdBy}`).emit('order:update', full);
  if (full.courier) io.to(`user:${full.courier.id}`).emit('order:update', full);
  return full;
}

async function setStatus(id: string, status: Status) {
  await pool.query(`INSERT INTO order_events (id, order_id, status) VALUES ($1,$2,$3)`, [randomUUID(), id, status]);
}

export async function createOrder(user: { id: string; role: string }, b: any) {
  if (user.role !== 'client' && user.role !== 'store') throw new HttpError(403, 'forbidden');
  if (!isLatLng(b.pickup) || !isLatLng(b.dropoff)) throw new HttpError(400, 'bad_location');
  const vehicle: Vehicle | null = VEHICLES.includes(b.vehicle) ? b.vehicle : null;
  const q = quote(b.pickup, b.dropoff, vehicle);
  if (!q) throw new HttpError(400, 'out_of_area');
  const item = clean(b.item, 200);
  if (!item) throw new HttpError(400, 'item_required');
  const open = await pool.query(
    `SELECT count(*)::int AS n FROM orders WHERE created_by = $1 AND status IN ('requested','accepted','at_pickup','picked_up')`, [user.id]);
  if (open.rows[0].n >= (user.role === 'store' ? 20 : 1)) throw new HttpError(409, 'order_in_progress');

  const id = randomUUID();
  for (let i = 0; ; i++) {
    try {
      await pool.query(
        `INSERT INTO orders (id, code, created_by, requester_role, status, country, pickup_label, pickup_lat, pickup_lng,
           dropoff_label, dropoff_lat, dropoff_lng, item, recipient_name, recipient_phone, vehicle_pref, distance_km, price, currency)
         VALUES ($1,$2,$3,$4,'requested',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [id, newCode(), user.id, user.role, q.country, clean(b.pickup.label, 160) || '—', b.pickup.lat, b.pickup.lng,
          clean(b.dropoff.label, 160) || '—', b.dropoff.lat, b.dropoff.lng, item,
          clean(b.recipientName, 80) || null, clean(b.recipientPhone, 30) || null, vehicle, q.distanceKm, q.price, q.currency]);
      break;
    } catch (e) { if (i >= 4) throw e; }
  }
  await setStatus(id, 'requested');
  dispatch(id, 0).catch((e) => console.error('[dispatch]', e));
  return orderView(id);
}

// ---------- Despacho ----------

const RADIUS = [6, 10, 16, 25]; // km, aumenta a cada tentativa
const RETRY_MS = 20000;
const MAX_TRIES = 15;
const offered = new Map<string, Set<string>>(); // pedido -> entregadores avisados
type DemoPick = (orderId: string, candidates: string[], realCount: number) => void;
export const dispatchHooks: { demoPick?: DemoPick } = {};

export async function dispatch(id: string, attempt: number) {
  const o = await orderView(id);
  if (!o || o.status !== 'requested') { offered.delete(id); return; }
  if (attempt >= MAX_TRIES) {
    const r = await pool.query(
      `UPDATE orders SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'requested' RETURNING id`, [id]);
    if (r.rows.length) {
      offered.delete(id);
      await setStatus(id, 'expired');
      await broadcast(id);
      await notify(o.createdBy, { type: 'order_status', orderId: id, code: o.code, status: 'expired' });
    }
    return;
  }
  const near = freeCouriersNear(o.pickup, RADIUS[Math.min(attempt, RADIUS.length - 1)], o.vehiclePref).slice(0, 8);
  const set = offered.get(id) ?? new Set<string>();
  offered.set(id, set);
  const offer = {
    id: o.id, code: o.code, pickup: o.pickup, dropoff: o.dropoff, item: o.item,
    distanceKm: o.distanceKm, price: o.price, currency: o.currency, ttl: RETRY_MS / 1000,
  };
  for (const { c, km } of near) {
    set.add(c.id);
    if (!c.demo) io.to(`user:${c.id}`).emit('order:offer', { ...offer, toPickupKm: Math.round(km * 10) / 10 });
  }
  dispatchHooks.demoPick?.(id, near.filter((x) => x.c.demo).map((x) => x.c.id), near.filter((x) => !x.c.demo).length);
  setTimeout(() => dispatch(id, attempt + 1).catch((e) => console.error('[dispatch]', e)), RETRY_MS).unref();
}

const accepting = new Set<string>();

export async function acceptOrder(id: string, courierId: string) {
  const live = online.get(courierId);
  if (!live) throw new HttpError(409, 'go_online_first');
  if (live.orderId || accepting.has(courierId)) throw new HttpError(409, 'order_in_progress');
  accepting.add(courierId); // impede o mesmo entregador de aceitar dois pedidos ao mesmo tempo
  let r;
  try {
    // O primeiro UPDATE que encontrar o pedido ainda "requested" ganha a corrida.
    r = await pool.query(
      `UPDATE orders SET courier_id = $2, status = 'accepted', updated_at = now() WHERE id = $1 AND status = 'requested' RETURNING id`,
      [id, courierId]);
    if (r.rows.length) live.orderId = id;
  } finally { accepting.delete(courierId); }
  if (!r.rows.length) throw new HttpError(409, 'already_taken');
  await setStatus(id, 'accepted');
  setBusy(courierId, id);
  for (const other of offered.get(id) ?? []) if (other !== courierId) io.to(`user:${other}`).emit('order:taken', id);
  offered.delete(id);
  const o = await broadcast(id);
  await notify(o.createdBy, { type: 'order_status', orderId: id, code: o.code, status: 'accepted' });
  return o;
}

export async function advanceOrder(id: string, courierId: string, to: Status) {
  const cur = (await pool.query(`SELECT status FROM orders WHERE id = $1 AND courier_id = $2`, [id, courierId])).rows[0];
  if (!cur) throw new HttpError(404, 'not_found');
  if (NEXT[cur.status as Status] !== to) throw new HttpError(409, 'bad_transition');
  const r = await pool.query(
    `UPDATE orders SET status = $3, updated_at = now() WHERE id = $1 AND status = $2 RETURNING id`, [id, cur.status, to]);
  if (!r.rows.length) throw new HttpError(409, 'bad_transition');
  await setStatus(id, to);
  if (to === 'delivered') {
    setBusy(courierId, null);
    await pool.query(`UPDATE couriers SET deliveries = deliveries + 1 WHERE user_id = $1`, [courierId]);
  }
  const o = await broadcast(id);
  await notify(o.createdBy, { type: 'order_status', orderId: id, code: o.code, status: to });
  return o;
}

export async function cancelOrder(id: string, user: { id: string }) {
  const cur = (await pool.query(`SELECT status, created_by, courier_id, code FROM orders WHERE id = $1`, [id])).rows[0];
  if (!cur || (cur.created_by !== user.id && cur.courier_id !== user.id)) throw new HttpError(404, 'not_found');
  const byCourier = cur.courier_id === user.id;
  // Depois da coleta o pacote já está com o entregador: não dá mais para cancelar pelo app.
  const allowed = byCourier ? ['accepted', 'at_pickup'] : ['requested', 'accepted', 'at_pickup'];
  if (!allowed.includes(cur.status)) throw new HttpError(409, 'cannot_cancel');

  if (byCourier) {
    // Entregador desistiu: o pedido volta para a fila em vez de ser cancelado para o cliente.
    const r = await pool.query(
      `UPDATE orders SET status = 'requested', courier_id = NULL, updated_at = now() WHERE id = $1 AND status = $2 RETURNING id`,
      [id, cur.status]);
    if (!r.rows.length) throw new HttpError(409, 'cannot_cancel');
    await setStatus(id, 'requested');
    setBusy(user.id, null);
    io.to(`user:${user.id}`).emit('order:update', { id, status: 'released' });
    const o = await broadcast(id);
    dispatch(id, 0).catch(() => {});
    return o;
  }
  const r = await pool.query(
    `UPDATE orders SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = $2 RETURNING id`, [id, cur.status]);
  if (!r.rows.length) throw new HttpError(409, 'cannot_cancel');
  await setStatus(id, 'cancelled');
  for (const c of offered.get(id) ?? []) io.to(`user:${c}`).emit('order:taken', id);
  offered.delete(id);
  if (cur.courier_id) {
    setBusy(cur.courier_id, null);
    await notify(cur.courier_id, { type: 'order_status', orderId: id, code: cur.code, status: 'cancelled' });
  }
  return broadcast(id);
}

export async function activeOrderFor(user: { id: string; role: string }) {
  const col = user.role === 'courier' ? 'courier_id' : 'created_by';
  const { rows } = await pool.query(
    `SELECT id FROM orders WHERE ${col} = $1 AND status IN ('requested','accepted','at_pickup','picked_up')
     ORDER BY created_at DESC LIMIT 1`, [user.id]);
  return rows[0] ? orderView(rows[0].id) : null;
}

export { OPEN };
