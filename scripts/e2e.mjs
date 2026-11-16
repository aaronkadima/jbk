// Teste ponta a ponta: sobe o servidor com banco em memória e percorre o fluxo inteiro
// (cadastro, aprovação, mapa ao vivo, pedido, aceite, coleta, entrega, notificações, link público).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(new URL('../server/package.json', import.meta.url));
const { io } = require('socket.io-client');

const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const srv = spawn('node', ['server/dist/index.js'], {
  env: { ...process.env, PORT: String(PORT), DATABASE_URL: process.env.E2E_DATABASE_URL ?? '', DEMO: '0', NODE_ENV: 'test', ADMIN_PHONE: '+10000000000', ADMIN_PASSWORD: 'admin123' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((ok, fail) => {
  srv.stdout.on('data', (d) => String(d).includes('[jbk]') && ok());
  srv.on('exit', (c) => fail(new Error(`servidor saiu (${c})`)));
});

const call = async (path, { token, body, method } = {}) => {
  const r = await fetch(BASE + '/api' + path, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json() };
};
const sock = (token) => new Promise((ok) => { const s = io(BASE, { auth: { token }, transports: ['websocket'] }); s.on('connect', () => ok(s)); });
const emit = (s, ev, arg) => new Promise((ok) => s.emit(ev, arg, ok));
const next = (s, ev, pred = () => true, ms = 4000) => new Promise((ok, fail) => {
  const t = setTimeout(() => fail(new Error(`timeout esperando ${ev}`)), ms);
  const fn = (x) => { if (pred(x)) { clearTimeout(t); s.off(ev, fn); ok(x); } };
  s.on(ev, fn);
});
let n = 0;
const step = (name) => console.log(`  ✓ ${String(++n).padStart(2)} ${name}`);

try {
  const kin = { lat: -4.3224, lng: 15.307 };           // Kinshasa
  const shop = { lat: -4.3105, lng: 15.2985, label: 'Marché Central' };
  const home = { lat: -4.335, lng: 15.32, label: 'Chez moi' };

  // Cadastros
  const client = (await call('/auth/register', { body: { role: 'client', name: 'Grace', phone: '+243810000001', password: 'segredo1', lang: 'fr' } })).data;
  const courier = (await call('/auth/register', { body: { role: 'courier', name: 'Patrick Moto', phone: '+243810000002', password: 'segredo1', vehicle: 'moto' } })).data;
  const rival = (await call('/auth/register', { body: { role: 'courier', name: 'Junior', phone: '+243810000003', password: 'segredo1', vehicle: 'moto' } })).data;
  const store = (await call('/auth/register', { body: { role: 'store', name: 'Ana', phone: '+5511990000004', password: 'segredo1', storeName: 'Loja da Ana' } })).data;
  assert.equal(courier.user.courier.status, 'pending');
  assert.equal((await call('/auth/register', { body: { role: 'client', name: 'X2', phone: '+243810000001', password: 'segredo1' } })).status, 409);
  assert.equal((await call('/auth/register', { body: { role: 'courier', name: 'Sem veículo', phone: '+243810000009', password: 'segredo1' } })).status, 400);
  step('cadastro de cliente, loja e entregadores (telefone duplicado e veículo ausente recusados)');

  // Entregador pendente não entra no mapa
  const cs = await sock(courier.token);
  assert.equal((await emit(cs, 'courier:online', kin)).error, 'not_approved');
  step('entregador pendente não consegue ficar online');

  // Aprovação
  const admin = (await call('/auth/login', { body: { phone: '+10000000000', password: 'admin123' } })).data;
  assert.equal((await call('/admin/couriers', { token: client.token })).status, 403);
  const pend = (await call('/admin/couriers', { token: admin.token })).data;
  assert.equal(pend.length, 2);
  const approvedNote = next(cs, 'notify', (x) => x.type === 'courier_approved');
  for (const p of pend) await call(`/admin/couriers/${p.id}/approve`, { token: admin.token, body: {} });
  await approvedNote;
  step('admin aprova e o entregador é notificado na hora');

  // Mapa ao vivo para visitante sem login
  const guest = await sock();
  assert.deepEqual(await emit(guest, 'map:watch', kin), []);
  const appear = next(guest, 'courier:update', (c) => c.id === courier.user.id);
  assert.equal((await emit(cs, 'courier:online', { lat: -4.312, lng: 15.3 })).ok, true);
  const seen = await appear;
  assert.equal(seen.vehicle, 'moto'); assert.equal(seen.name, 'Patrick'); assert.equal(seen.phone, undefined);
  const moved = next(guest, 'courier:update', (c) => c.lat === -4.3125);
  cs.emit('courier:pos', { lat: -4.3125, lng: 15.3005 });
  await moved;
  const far = await sock();
  assert.deepEqual(await emit(far, 'map:watch', { lat: -23.55, lng: -46.63 }), []);
  assert.equal((await emit(guest, 'map:watch', kin)).length, 1);
  step('visitante vê o entregador aparecer e se mover; quem olha São Paulo não recebe Kinshasa');

  const rs = await sock(rival.token);
  await emit(rs, 'courier:online', { lat: -4.313, lng: 15.301 });

  // Orçamento e pedido
  const q = (await call('/quote', { body: { pickup: shop, dropoff: home, vehicle: 'moto' } })).data;
  assert.equal(q.currency, 'CDF'); assert.ok(q.price > 2000);
  assert.equal((await call('/quote', { body: { pickup: shop, dropoff: { lat: 48.85, lng: 2.35 } } })).status, 400);
  assert.equal((await call('/orders', { body: { pickup: shop, dropoff: home, item: 'x' } })).status, 401);
  const cl = await sock(client.token);
  const offer1 = next(cs, 'order:offer'), offer2 = next(rs, 'order:offer');
  const order = (await call('/orders', { token: client.token, body: { pickup: shop, dropoff: home, item: 'Sac de farine', vehicle: 'moto' } })).data;
  assert.equal(order.status, 'requested'); assert.equal(order.code.length, 6);
  assert.equal((await call('/orders', { token: client.token, body: { pickup: shop, dropoff: home, item: 'outro' } })).status, 409);
  const [o1] = await Promise.all([offer1, offer2]);
  assert.equal(o1.id, order.id); assert.ok(o1.toPickupKm < 1);
  step('orçamento em CDF, área fora de serviço recusada, oferta chega aos dois entregadores próximos');

  // Corrida pelo aceite
  await emit(cl, 'order:watch', { id: order.id });
  const acceptedNote = next(cl, 'notify', (x) => x.status === 'accepted');
  const taken = next(rs, 'order:taken');
  const gone = next(guest, 'courier:gone', (id) => id === courier.user.id);
  const [a, b] = await Promise.all([
    call(`/orders/${order.id}/accept`, { token: courier.token, body: {} }),
    call(`/orders/${order.id}/accept`, { token: rival.token, body: {} }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const winner = a.status === 200 ? { tok: courier.token, s: cs, u: courier.user } : { tok: rival.token, s: rs, u: rival.user };
  await acceptedNote;
  if (winner.u.id === courier.user.id) await Promise.all([taken, gone]);
  step('dois aceites simultâneos: só um vence; cliente notificado; o ocupado some do mapa público');

  // Rastreamento durante a entrega + link público
  const pubTrack = await sock();
  const w = await emit(pubTrack, 'order:watch', { code: order.code });
  assert.equal(w.ok, true); assert.ok(w.courier);
  const live1 = next(cl, 'order:courier'), live2 = next(pubTrack, 'order:courier');
  winner.s.emit('courier:pos', { lat: -4.3108, lng: 15.2988, heading: 90 });
  assert.equal((await live1).heading, 90); await live2;
  const tr = (await call(`/track/${order.code}`)).data;
  assert.equal(tr.status, 'accepted'); assert.equal(tr.courier.phone, undefined); assert.equal(tr.recipientPhone, undefined);
  assert.ok((await call(`/orders/${order.id}`, { token: client.token })).data.courier.phone);
  step('posição do entregador chega ao cliente e ao link público, sem expor telefone no link');

  // Status em sequência, cada um com notificação
  assert.equal((await call(`/orders/${order.id}/status`, { token: winner.tok, body: { status: 'delivered' } })).status, 409);
  for (const st of ['at_pickup', 'picked_up', 'delivered']) {
    const note = next(cl, 'notify', (x) => x.status === st);
    const upd = next(pubTrack, 'order:update', (x) => x.status === st);
    assert.equal((await call(`/orders/${order.id}/status`, { token: winner.tok, body: { status: st } })).data.status, st);
    await Promise.all([note, upd]);
    if (st === 'picked_up')
      assert.equal((await call(`/orders/${order.id}/cancel`, { token: client.token, body: {} })).status, 409);
  }
  const notes = (await call('/notifications', { token: client.token })).data;
  assert.deepEqual(notes.map((x) => x.status).sort(), ['accepted', 'at_pickup', 'delivered', 'picked_up']);
  assert.equal((await emit(guest, 'map:watch', kin)).length, 2);
  step('chegou → coletou → entregou, uma notificação por mudança; pular etapa é recusado; entregador volta ao mapa');

  // Loja pede entrega para o cliente dela (Brasil) e cancela
  const sp = { lat: -23.5505, lng: -46.6333, label: 'Loja da Ana' };
  const so = (await call('/orders', { token: store.token, body: { pickup: sp, dropoff: { lat: -23.56, lng: -46.65, label: 'Rua A, 10' }, item: 'Tênis', recipientName: 'Bia', recipientPhone: '+5511988887777' } })).data;
  assert.equal(so.currency, 'BRL'); assert.equal(so.requesterRole, 'store'); assert.equal(so.recipientName, 'Bia');
  assert.equal((await call(`/orders/${so.id}/cancel`, { token: store.token, body: {} })).data.status, 'cancelled');
  step('loja solicita entrega ao cliente dela em BRL e cancela antes do aceite');

  // Entregador desiste: pedido volta para a fila
  const o2 = (await call('/orders', { token: client.token, body: { pickup: shop, dropoff: home, item: 'Pain' } })).data;
  await call(`/orders/${o2.id}/accept`, { token: courier.token, body: {} });
  const back = next(cl, 'order:update', (x) => x.id === o2.id && x.status === 'requested');
  const reoffer = next(rs, 'order:offer', (x) => x.id === o2.id);
  await call(`/orders/${o2.id}/cancel`, { token: courier.token, body: {} });
  await Promise.all([back, reoffer]);
  step('entregador desiste: pedido volta para a fila e é reoferecido');

  // Offline
  const left = next(guest, 'courier:gone', (id) => id === rival.user.id);
  rs.disconnect();
  await left;
  step('entregador que desconecta some do mapa');

  console.log(`\n${n} verificações passaram.`);
  for (const s of [cs, cl, guest, far, pubTrack]) s.disconnect();
} catch (e) {
  console.error('\nFALHOU:', e);
  process.exitCode = 1;
} finally {
  srv.kill();
}
