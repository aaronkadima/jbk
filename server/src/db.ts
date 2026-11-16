import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { env } from './config.js';

type Q = { rows: any[]; rowCount: number | null };
export let pool: { query: (text: string, params?: any[]) => Promise<Q> };

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY,
    role text NOT NULL,
    name text NOT NULL,
    phone text NOT NULL UNIQUE,
    password_hash text NOT NULL,
    lang text NOT NULL DEFAULT 'pt',
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS couriers (
    user_id text PRIMARY KEY,
    vehicle text NOT NULL,
    plate text,
    status text NOT NULL DEFAULT 'pending',
    last_lat double precision,
    last_lng double precision,
    deliveries integer NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS stores (
    user_id text PRIMARY KEY,
    store_name text NOT NULL,
    lat double precision,
    lng double precision
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id text PRIMARY KEY,
    code text NOT NULL UNIQUE,
    created_by text NOT NULL,
    requester_role text NOT NULL,
    courier_id text,
    status text NOT NULL,
    country text NOT NULL,
    pickup_label text NOT NULL,
    pickup_lat double precision NOT NULL,
    pickup_lng double precision NOT NULL,
    dropoff_label text NOT NULL,
    dropoff_lat double precision NOT NULL,
    dropoff_lng double precision NOT NULL,
    item text NOT NULL,
    recipient_name text,
    recipient_phone text,
    vehicle_pref text,
    distance_km double precision NOT NULL,
    price double precision NOT NULL,
    currency text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS orders_creator ON orders (created_by)`,
  `CREATE INDEX IF NOT EXISTS orders_courier ON orders (courier_id)`,
  `CREATE TABLE IF NOT EXISTS order_events (
    id text PRIMARY KEY,
    order_id text NOT NULL,
    status text NOT NULL,
    at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id text PRIMARY KEY,
    user_id text NOT NULL,
    type text NOT NULL,
    order_id text,
    code text,
    status text,
    is_read boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS notifications_user ON notifications (user_id)`,
  `CREATE TABLE IF NOT EXISTS push_subs (
    endpoint text PRIMARY KEY,
    user_id text NOT NULL,
    sub text NOT NULL
  )`,
];

export async function initDb() {
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
    });
  } else {
    if (env.prod && process.env.ALLOW_MEMORY_DB !== '1')
      throw new Error('DATABASE_URL é obrigatória em produção.');
    const { newDb } = await import('pg-mem');
    const mem = newDb();
    const { Pool } = mem.adapters.createPg();
    pool = new Pool();
    console.warn('[db] DATABASE_URL ausente: usando banco em memória. Os dados somem ao reiniciar.');
  }
  for (const stmt of SCHEMA) await pool.query(stmt);

  const admin = await pool.query(`SELECT id FROM users WHERE role = 'admin' LIMIT 1`);
  if (!admin.rows.length) {
    if (env.prod && !process.env.ADMIN_PASSWORD) throw new Error('Defina ADMIN_PHONE e ADMIN_PASSWORD em produção.');
    await pool.query(
      `INSERT INTO users (id, role, name, phone, password_hash) VALUES ($1, 'admin', 'Admin', $2, $3)`,
      [randomUUID(), env.adminPhone, await bcrypt.hash(env.adminPassword, 10)],
    );
    console.log(`[db] conta admin criada: ${env.adminPhone}`);
  }
}
