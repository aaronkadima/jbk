import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config.js';
import { initDb, pool } from './db.js';
import { initHub } from './hub.js';
import { api } from './api.js';
import { initDemo } from './demo.js';
import { dispatch } from './orders.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));
app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.use('/api', api);

// Em produção o mesmo servidor entrega a PWA já compilada.
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist, { index: false, maxAge: '1h' }));
  app.get('*', (_req, res) => res.sendFile(path.join(webDist, 'index.html')));
}

const server = createServer(app);

await initDb();
initHub(server);
if (env.demo) initDemo();

// Pedidos que ficaram aguardando entregador quando o servidor reiniciou voltam para a fila.
const waiting = await pool.query(`SELECT id FROM orders WHERE status = 'requested'`);
for (const r of waiting.rows) dispatch(r.id, 0).catch(() => {});

server.listen(env.port, () => console.log(`[jbk] http://localhost:${env.port}`));
