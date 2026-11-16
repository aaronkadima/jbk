// Estado em tempo real: entregadores online, salas por célula geográfica e notificações.
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server, type Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import webpush from 'web-push';
import { pool } from './db.js';
import { env, isLatLng, bearing, haversineKm, type LatLng, type Vehicle } from './config.js';

export type Live = {
  id: string; name: string; vehicle: Vehicle;
  lat: number; lng: number; heading: number; cell: string;
  orderId: string | null; demo?: boolean;
};

export const online = new Map<string, Live>();
export let io: Server;

// Células de ~5,5 km. Cada pessoa olhando o mapa entra nas 25 células ao redor do centro da tela,
// então uma atualização de posição só viaja para quem está vendo aquela região.
const CELL = 0.05;
const cellOf = (p: LatLng) => `${Math.floor(p.lat / CELL)}:${Math.floor(p.lng / CELL)}`;
const cellsAround = (p: LatLng, r = 2) => {
  const a = Math.floor(p.lat / CELL), b = Math.floor(p.lng / CELL), out: string[] = [];
  for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) out.push(`${a + i}:${b + j}`);
  return out;
};

export const pub = (c: Live) => ({
  id: c.id, name: c.name.split(' ')[0], vehicle: c.vehicle,
  lat: c.lat, lng: c.lng, heading: Math.round(c.heading),
});

export function addLive(c: Omit<Live, 'cell'>) {
  const live: Live = { ...c, cell: cellOf(c) };
  online.set(c.id, live);
  if (!live.orderId) io.to(`cell:${live.cell}`).emit('courier:update', pub(live));
  return live;
}

export function removeLive(id: string) {
  const c = online.get(id);
  if (!c) return;
  online.delete(id);
  io.to(`cell:${c.cell}`).emit('courier:gone', id);
}

export function moveLive(id: string, p: LatLng, heading?: number) {
  const c = online.get(id);
  if (!c) return;
  const moved = haversineKm(c, p) > 0.003;
  c.heading = Number.isFinite(heading) ? (heading as number) : moved ? bearing(c, p) : c.heading;
  c.lat = p.lat; c.lng = p.lng;
  const next = cellOf(p);
  if (c.orderId) {
    c.cell = next;
    io.to(`order:${c.orderId}`).emit('order:courier', pub(c));
    return;
  }
  if (next !== c.cell) {
    io.to(`cell:${c.cell}`).except(`cell:${next}`).emit('courier:gone', id);
    c.cell = next;
  }
  io.to(`cell:${c.cell}`).emit('courier:update', pub(c));
}

/** Entregador ocupado some do mapa público e passa a ser visto só por quem acompanha o pedido. */
export function setBusy(id: string, orderId: string | null) {
  const c = online.get(id);
  if (!c) return;
  c.orderId = orderId;
  if (orderId) io.to(`cell:${c.cell}`).emit('courier:gone', id);
  else io.to(`cell:${c.cell}`).emit('courier:update', pub(c));
}

export const freeCouriersNear = (p: LatLng, radiusKm: number, vehicle: Vehicle | null) =>
  [...online.values()]
    .filter((c) => !c.orderId && (!vehicle || c.vehicle === vehicle))
    .map((c) => ({ c, km: haversineKm(c, p) }))
    .filter((x) => x.km <= radiusKm)
    .sort((a, b) => a.km - b.km);

// ---------- Notificações ----------

const PUSH_TEXT: Record<string, Record<string, string>> = {
  pt: {
    accepted: 'Um entregador aceitou seu pedido', at_pickup: 'O entregador chegou ao local de coleta',
    picked_up: 'Pacote coletado, a caminho', delivered: 'Pedido entregue', cancelled: 'Pedido cancelado',
    expired: 'Nenhum entregador disponível agora', courier_approved: 'Cadastro aprovado. Você já pode ficar online',
    courier_rejected: 'Seu cadastro não foi aprovado',
  },
  fr: {
    accepted: 'Un livreur a accepté votre commande', at_pickup: 'Le livreur est arrivé au point de retrait',
    picked_up: 'Colis récupéré, en route', delivered: 'Commande livrée', cancelled: 'Commande annulée',
    expired: 'Aucun livreur disponible pour le moment', courier_approved: 'Inscription approuvée. Vous pouvez passer en ligne',
    courier_rejected: "Votre inscription n'a pas été approuvée",
  },
  en: {
    accepted: 'A courier accepted your order', at_pickup: 'The courier is at the pickup point',
    picked_up: 'Package picked up, on the way', delivered: 'Order delivered', cancelled: 'Order cancelled',
    expired: 'No courier available right now', courier_approved: 'Sign-up approved. You can go online',
    courier_rejected: 'Your sign-up was not approved',
  },
};

const pushOn = !!(env.vapidPublic && env.vapidPrivate);
if (pushOn) webpush.setVapidDetails(env.vapidSubject, env.vapidPublic, env.vapidPrivate);

export async function notify(userId: string, n: { type: string; orderId?: string; code?: string; status?: string }) {
  const note = { id: randomUUID(), ...n, read: false, createdAt: new Date().toISOString() };
  await pool.query(
    `INSERT INTO notifications (id, user_id, type, order_id, code, status) VALUES ($1,$2,$3,$4,$5,$6)`,
    [note.id, userId, n.type, n.orderId ?? null, n.code ?? null, n.status ?? null],
  );
  io.to(`user:${userId}`).emit('notify', note);
  if (!pushOn) return;
  const [{ rows: subs }, { rows: us }] = await Promise.all([
    pool.query(`SELECT endpoint, sub FROM push_subs WHERE user_id = $1`, [userId]),
    pool.query(`SELECT lang FROM users WHERE id = $1`, [userId]),
  ]);
  const text = (PUSH_TEXT[us[0]?.lang] ?? PUSH_TEXT.pt)[n.status ?? n.type];
  if (!text) return;
  const payload = JSON.stringify({ title: n.code ? `JBK · ${n.code}` : 'JBK', body: text, tag: n.orderId ?? n.type });
  for (const s of subs) {
    webpush.sendNotification(JSON.parse(s.sub), payload).catch(async (e) => {
      if (e.statusCode === 404 || e.statusCode === 410)
        await pool.query(`DELETE FROM push_subs WHERE endpoint = $1`, [s.endpoint]);
    });
  }
}

// ---------- Sockets ----------

type Hooks = { onWatch?: (p: LatLng) => void };
export const hooks: Hooks = {};

const ACTIVE = `('accepted','at_pickup','picked_up')`;

export function initHub(server: HttpServer) {
  io = new Server(server, { cors: env.prod ? undefined : { origin: true } });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token) {
      try { socket.data.user = jwt.verify(token, env.jwtSecret) as { id: string; role: string }; } catch { /* visitante */ }
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = socket.data.user as { id: string; role: string } | undefined;
    if (user) socket.join(`user:${user.id}`);

    socket.on('map:watch', (p, ack) => {
      if (!isLatLng(p)) return;
      for (const r of socket.rooms) if (r.startsWith('cell:')) socket.leave(r);
      const cells = cellsAround(p);
      for (const c of cells) socket.join(`cell:${c}`);
      hooks.onWatch?.(p);
      const set = new Set(cells);
      const list = [...online.values()].filter((c) => !c.orderId && set.has(c.cell)).map(pub);
      if (typeof ack === 'function') ack(list);
    });

    socket.on('courier:online', async (p, ack) => {
      const done = (r: any) => typeof ack === 'function' && ack(r);
      if (!user || user.role !== 'courier' || !isLatLng(p)) return done({ error: 'forbidden' });
      const { rows } = await pool.query(
        `SELECT u.name, c.vehicle, c.status FROM users u JOIN couriers c ON c.user_id = u.id WHERE u.id = $1`, [user.id]);
      if (rows[0]?.status !== 'approved') return done({ error: 'not_approved' });
      const act = await pool.query(`SELECT id FROM orders WHERE courier_id = $1 AND status IN ${ACTIVE} LIMIT 1`, [user.id]);
      addLive({
        id: user.id, name: rows[0].name, vehicle: rows[0].vehicle, lat: p.lat, lng: p.lng,
        heading: 0, orderId: act.rows[0]?.id ?? null,
      });
      socket.data.courierOnline = true;
      done({ ok: true });
    });

    socket.on('courier:pos', (p: any) => {
      const heading = typeof p?.heading === 'number' ? p.heading : undefined;
      if (!user || !socket.data.courierOnline || !isLatLng(p)) return;
      moveLive(user.id, p, heading);
      const now = Date.now();
      if (now - (socket.data.saved ?? 0) > 15000) {
        socket.data.saved = now;
        pool.query(`UPDATE couriers SET last_lat = $2, last_lng = $3 WHERE user_id = $1`, [user.id, p.lat, p.lng]).catch(() => {});
      }
    });

    const goOffline = () => {
      if (!user || !socket.data.courierOnline) return;
      socket.data.courierOnline = false;
      const others = [...(io.sockets.adapter.rooms.get(`user:${user.id}`) ?? [])]
        .some((sid) => sid !== socket.id && io.sockets.sockets.get(sid)?.data.courierOnline);
      if (!others) removeLive(user.id);
    };
    socket.on('courier:offline', goOffline);
    socket.on('disconnect', goOffline);

    // Acompanhar um pedido: pelas partes (id) ou por quem recebeu o link público (código).
    socket.on('order:watch', async (q, ack) => {
      const done = (r: any) => typeof ack === 'function' && ack(r);
      let row: any;
      if (typeof q?.code === 'string') {
        row = (await pool.query(`SELECT id, courier_id FROM orders WHERE code = $1`, [q.code.toUpperCase()])).rows[0];
      } else if (typeof q?.id === 'string' && user) {
        row = (await pool.query(
          `SELECT id, courier_id FROM orders WHERE id = $1 AND (created_by = $2 OR courier_id = $2)`, [q.id, user.id])).rows[0];
      }
      if (!row) return done({ error: 'not_found' });
      socket.join(`order:${row.id}`);
      const live = row.courier_id ? online.get(row.courier_id) : undefined;
      done({ ok: true, courier: live && live.orderId === row.id ? pub(live) : null });
    });

    socket.on('order:unwatch', (id) => typeof id === 'string' && socket.leave(`order:${id}`));
  });
}
