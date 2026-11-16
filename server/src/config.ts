export type Vehicle = 'foot' | 'bike' | 'moto' | 'car';
export const VEHICLES: Vehicle[] = ['foot', 'bike', 'moto', 'car'];
export type CountryCode = 'CD' | 'BR' | 'US';
export type LatLng = { lat: number; lng: number };

type Country = {
  code: CountryCode;
  currency: string;
  base: number; // tarifa fixa
  perKm: number;
  round: number; // arredondamento do preço
  center: LatLng; // centro padrão quando não há GPS
  boxes: [number, number, number, number][]; // [latMin, latMax, lngMin, lngMax]
};

export const COUNTRIES: Record<CountryCode, Country> = {
  CD: {
    code: 'CD', currency: 'CDF', base: 2000, perKm: 1200, round: 100,
    center: { lat: -4.3224, lng: 15.3070 },
    boxes: [[-13.5, 5.4, 12.2, 31.3]],
  },
  BR: {
    code: 'BR', currency: 'BRL', base: 6, perKm: 2.2, round: 0.1,
    center: { lat: -23.5505, lng: -46.6333 },
    boxes: [[-34, 5.3, -74, -34]],
  },
  US: {
    code: 'US', currency: 'USD', base: 4, perKm: 1.6, round: 0.05,
    center: { lat: 40.7128, lng: -74.006 },
    boxes: [[24.5, 49.4, -125, -66.9], [51, 71.5, -170, -130], [18.9, 22.3, -160.3, -154.8]],
  },
};

const VEHICLE_FACTOR: Record<Vehicle, number> = { foot: 0.8, bike: 0.9, moto: 1, car: 1.4 };

export function countryAt(p: LatLng): CountryCode | null {
  for (const c of Object.values(COUNTRIES))
    for (const [a, b, x, y] of c.boxes)
      if (p.lat >= a && p.lat <= b && p.lng >= x && p.lng <= y) return c.code;
  return null;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export function bearing(a: LatLng, b: LatLng): number {
  const rad = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * rad) * Math.cos(b.lat * rad);
  const x = Math.cos(a.lat * rad) * Math.sin(b.lat * rad) -
    Math.sin(a.lat * rad) * Math.cos(b.lat * rad) * Math.cos((b.lng - a.lng) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

/** Distância de rua estimada: linha reta com fator de desvio urbano. */
export function quote(pickup: LatLng, dropoff: LatLng, vehicle: Vehicle | null) {
  const country = countryAt(pickup);
  if (!country || countryAt(dropoff) !== country) return null;
  const c = COUNTRIES[country];
  const distanceKm = Math.max(0.3, haversineKm(pickup, dropoff) * 1.3);
  const raw = (c.base + c.perKm * distanceKm) * VEHICLE_FACTOR[vehicle ?? 'moto'];
  const price = Math.round(Math.round(raw / c.round) * c.round * 100) / 100;
  return { country, currency: c.currency, distanceKm: Math.round(distanceKm * 10) / 10, price };
}

export const isLatLng = (p: any): p is LatLng =>
  p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

export const env = {
  port: Number(process.env.PORT ?? 4000),
  prod: process.env.NODE_ENV === 'production',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-nao-usar-em-producao',
  demo: process.env.DEMO === '1',
  adminPhone: process.env.ADMIN_PHONE ?? '+10000000000',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin123',
  vapidPublic: process.env.VAPID_PUBLIC_KEY ?? '',
  vapidPrivate: process.env.VAPID_PRIVATE_KEY ?? '',
  vapidSubject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
};
