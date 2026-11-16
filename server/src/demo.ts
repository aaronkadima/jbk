// Modo demonstração (DEMO=1): entregadores simulados aparecem perto de quem abre o mapa,
// circulam, aceitam pedidos e fazem a entrega. Serve para mostrar e testar o fluxo sem frota real.
import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { online, addLive, moveLive, removeLive, hooks } from './hub.js';
import { acceptOrder, advanceOrder, dispatchHooks, orderView } from './orders.js';
import { countryAt, haversineKm, bearing, VEHICLES, type LatLng, type Vehicle } from './config.js';

const NAMES = ['Kito', 'Malu', 'Jojo', 'Nia', 'Beto', 'Zola', 'Rafa', 'Mika', 'Dudu', 'Sami', 'Leo', 'Yara'];
const PER_AREA = 6, MAX = 60, IDLE_MS = 10 * 60 * 1000;
const SPEED: Record<Vehicle, number> = { foot: 2, bike: 5, moto: 9, car: 8 }; // m/s vagando
const M = 1 / 111320; // graus por metro (latitude)

type Sim = { id: string; home: LatLng; target: LatLng | null; job: null | { orderId: string; phase: 'pickup' | 'dropoff'; wait: number }; seen: number };
const sims = new Map<string, Sim>();

const jitter = (p: LatLng, meters: number): LatLng => ({
  lat: p.lat + (Math.random() - 0.5) * 2 * meters * M,
  lng: p.lng + ((Math.random() - 0.5) * 2 * meters * M) / Math.cos((p.lat * Math.PI) / 180),
});

function step(from: LatLng, to: LatLng, meters: number): LatLng {
  const d = haversineKm(from, to) * 1000;
  if (d <= meters) return to;
  const f = meters / d;
  return { lat: from.lat + (to.lat - from.lat) * f, lng: from.lng + (to.lng - from.lng) * f };
}

async function spawn(center: LatLng) {
  const id = randomUUID();
  const name = NAMES[Math.floor(Math.random() * NAMES.length)];
  const vehicle = VEHICLES[Math.floor(Math.random() * VEHICLES.length)];
  await pool.query(`INSERT INTO users (id, role, name, phone, password_hash) VALUES ($1,'courier',$2,$3,'-')`, [id, name, `demo-${id}`]);
  await pool.query(`INSERT INTO couriers (user_id, vehicle, status) VALUES ($1,$2,'approved')`, [id, vehicle]);
  const pos = jitter(center, 900);
  sims.set(id, { id, home: center, target: null, job: null, seen: Date.now() });
  addLive({ id, name, vehicle, lat: pos.lat, lng: pos.lng, heading: Math.random() * 360, orderId: null, demo: true });
}

let spawning = false;
async function ensureNear(p: LatLng) {
  if (spawning || !countryAt(p)) return;
  const near = [...sims.values()].filter((s) => { const l = online.get(s.id); return l && haversineKm(l, p) < 4; });
  for (const s of near) s.seen = Date.now();
  spawning = true;
  try {
    for (let i = near.length; i < PER_AREA && sims.size < MAX; i++) await spawn(p);
  } finally { spawning = false; }
}

async function tick() {
  for (const s of sims.values()) {
    const live = online.get(s.id);
    if (!live) { sims.delete(s.id); continue; }
    if (!s.job) {
      if (Date.now() - s.seen > IDLE_MS) { removeLive(s.id); sims.delete(s.id); continue; }
      if (!s.target || haversineKm(live, s.target) < 0.02) s.target = jitter(s.home, 1100);
      const next = step(live, s.target, SPEED[live.vehicle]);
      moveLive(s.id, next, bearing(live, s.target));
      continue;
    }
    s.seen = Date.now();
    if (s.job.wait > 0) { s.job.wait--; continue; }
    const o = await orderView(s.job.orderId);
    if (!o || o.courier?.id !== s.id || ['cancelled', 'delivered', 'expired'].includes(o.status)) { s.job = null; continue; }
    const dest: LatLng = s.job.phase === 'pickup' ? o.pickup : o.dropoff;
    if (haversineKm(live, dest) > 0.015) {
      moveLive(s.id, step(live, dest, 28), bearing(live, dest)); // acelerado para a demonstração
      continue;
    }
    try {
      if (o.status === 'accepted') { await advanceOrder(o.id, s.id, 'at_pickup'); s.job.wait = 4; }
      else if (o.status === 'at_pickup') { await advanceOrder(o.id, s.id, 'picked_up'); s.job.phase = 'dropoff'; s.job.wait = 1; }
      else if (o.status === 'picked_up') { await advanceOrder(o.id, s.id, 'delivered'); s.home = dest; s.job = null; }
    } catch { s.job = null; }
  }
}

export function initDemo() {
  hooks.onWatch = (p) => { ensureNear(p).catch((e) => console.error('[demo]', e)); };
  // Entregadores reais têm 12 s de preferência; sem eles, o simulado aceita em 3 s.
  dispatchHooks.demoPick = (orderId, candidates, realCount) => {
    if (!candidates.length) return;
    setTimeout(async () => {
      for (const id of candidates) {
        const s = sims.get(id);
        if (!s || s.job) continue;
        try {
          await acceptOrder(orderId, id);
          s.job = { orderId, phase: 'pickup', wait: 1 };
        } catch { /* outro aceitou antes */ }
        return;
      }
    }, realCount ? 12000 : 3000).unref();
  };
  let busy = false;
  setInterval(() => {
    if (busy) return;
    busy = true;
    tick().catch((e) => console.error('[demo]', e)).finally(() => { busy = false; });
  }, 1000).unref();
  console.log('[demo] entregadores simulados ativos');
}
