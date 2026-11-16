// Controle do mapa: marcadores animados dos entregadores, rota, pinos e posição do usuário.
import maplibregl, { type Map as GlMap, type Marker, type GeoJSONSource } from 'maplibre-gl';
import { buildStyle, installPatterns, PAPER } from './style';

export type LatLng = { lat: number; lng: number };
export type Vehicle = 'foot' | 'bike' | 'moto' | 'car';
export type CourierPin = LatLng & { id: string; name: string; vehicle: Vehicle; heading: number };

// Ícones de traço simples, no espírito de sinete de cartógrafo.
export const VEHICLE_ICON: Record<Vehicle, string> = {
  foot: '<circle cx="13" cy="5" r="2"/><path d="M13 8l-3 4 3 3v5M10 12l-3 1M13 11l3 2 2-1M10 16l-2 4"/>',
  bike: '<circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9.5 8h5l4 8.5H12l-2.5-8.5M9 6h4m1 1.5 2 0m-6 9h2m-2.5-8.5h4.5"/>',
  moto: '<circle cx="5.3" cy="16.5" r="3.2"/><circle cx="18.8" cy="16.5" r="3.2"/><path d="m5.3 16.5 4-6.2h4.9l4.6 6.2M9.3 10.3l-2.1 6.2m6.9-6.2 2.3-2.1 2.4 1.4M12 10.3 14 16.5H9m-1-8h4l1.2-2h3.2m-5.2-1.5h2.8"/>',
  car: '<path d="M2 6h12v11H2zM14 10h4l4 4v3h-8M2 17h2m8 0h4m5 0h1M14 6v11"/><circle cx="8" cy="17" r="2.3"/><circle cx="19" cy="17" r="2.3"/>',
};
export const icon = (v: Vehicle, size = 22) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${VEHICLE_ICON[v]}</svg>`;

type Anim = { marker: Marker; el: HTMLElement; from: LatLng; to: LatLng; t0: number; dur: number; last: number; heading: number };

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EMPTY = { type: 'FeatureCollection' as const, features: [] };

class MapCtl {
  map!: GlMap;
  ready = false;
  private couriers = new Map<string, Anim>();
  private raf = 0;
  private me?: Marker;
  private pins: Marker[] = [];
  private dashTimer = 0;
  private onReady: (() => void)[] = [];
  onCourierTap?: (c: CourierPin) => void;

  mount(container: HTMLElement, center: LatLng, zoom: number) {
    this.map = new maplibregl.Map({
      container, style: buildStyle(), center: [center.lng, center.lat], zoom,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, maxPitch: 0,
    });
    // Attribution stays visible as text (OSM licensing), with no compact info button.
    this.map.addControl(new maplibregl.AttributionControl({ compact: false }), 'bottom-left');
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    installPatterns(this.map);
    this.map.touchZoomRotate.disableRotation();
    // 'style.load' não depende dos tiles: rota e pinos funcionam mesmo se o servidor de mapas falhar.
    this.map.once('style.load', () => {
      this.map.addSource('route', { type: 'geojson', data: EMPTY });
      this.map.addLayer({ id: 'route-bed', type: 'line', source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': PAPER, 'line-width': 9, 'line-opacity': 0.9 } });
      this.map.addLayer({ id: 'route', type: 'line', source: 'route',
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#176943', 'line-width': 4, 'line-dasharray': [1.4, 1.6] } });
      this.ready = true;
      this.onReady.splice(0).forEach((f) => f());
    });
    return this.map;
  }

  private whenReady(f: () => void) { this.ready ? f() : this.onReady.push(f); }
  center(): LatLng { const c = this.map.getCenter(); return { lat: c.lat, lng: c.lng }; }
  flyTo(p: LatLng, zoom?: number) {
    this.map.flyTo({ center: [p.lng, p.lat], zoom: zoom ?? Math.max(this.map.getZoom(), 15), duration: reduced() ? 0 : 900 });
  }
  fit(points: LatLng[], bottomPad = 320) {
    if (points.length < 2) return;
    const b = new maplibregl.LngLatBounds();
    points.forEach((p) => b.extend([p.lng, p.lat]));
    this.map.fitBounds(b, { padding: { top: 110, left: 60, right: 60, bottom: bottomPad }, maxZoom: 16, duration: reduced() ? 0 : 900 });
  }

  // ----- Entregadores -----

  upsertCourier(c: CourierPin, variant: 'free' | 'mine' = 'free') {
    const now = performance.now();
    let a = this.couriers.get(c.id);
    if (!a) {
      const el = document.createElement('button');
      el.className = `tok tok--${variant}`;
      el.setAttribute('aria-label', c.name);
      el.innerHTML = `<span class="tok__dir"></span><span class="tok__body">${icon(c.vehicle)}</span>`;
      el.addEventListener('click', (e) => { e.stopPropagation(); this.onCourierTap?.(c); });
      const marker = new maplibregl.Marker({ element: el }).setLngLat([c.lng, c.lat]).addTo(this.map);
      a = { marker, el, from: c, to: c, t0: now, dur: 0, last: now, heading: c.heading };
      this.couriers.set(c.id, a);
    } else {
      // Desliza da posição atual até a nova durante o intervalo entre atualizações.
      const cur = a.marker.getLngLat();
      a.from = { lat: cur.lat, lng: cur.lng };
      a.to = c;
      a.dur = reduced() ? 0 : Math.min(2500, Math.max(300, now - a.last));
      a.t0 = now; a.last = now;
      a.el.className = `tok tok--${variant}`;
    }
    // Gira pelo caminho mais curto para a seta não dar a volta inteira.
    const delta = ((c.heading - a.heading + 540) % 360) - 180;
    a.heading += delta;
    (a.el.firstElementChild as HTMLElement).style.transform = `rotate(${a.heading}deg)`;
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    let moving = false;
    for (const a of this.couriers.values()) {
      if (a.t0 < 0) continue;
      const k = a.dur ? Math.min(1, (now - a.t0) / a.dur) : 1;
      a.marker.setLngLat([a.from.lng + (a.to.lng - a.from.lng) * k, a.from.lat + (a.to.lat - a.from.lat) * k]);
      if (k < 1) moving = true; else a.t0 = -1;
    }
    this.raf = moving ? requestAnimationFrame(this.frame) : 0;
  };

  removeCourier(id: string) {
    const a = this.couriers.get(id);
    if (!a) return;
    this.couriers.delete(id);
    a.el.classList.add('tok--out');
    setTimeout(() => a.marker.remove(), reduced() ? 0 : 220);
  }
  setCouriers(list: CourierPin[]) {
    const keep = new Set(list.map((c) => c.id));
    for (const id of [...this.couriers.keys()]) if (!keep.has(id)) this.removeCourier(id);
    list.forEach((c) => this.upsertCourier(c));
  }
  courierIds() { return [...this.couriers.keys()]; }

  // ----- Usuário, pinos e rota -----

  setMe(p: LatLng | null) {
    if (!p) { this.me?.remove(); this.me = undefined; return; }
    if (!this.me) {
      const el = document.createElement('div');
      el.className = 'me';
      this.me = new maplibregl.Marker({ element: el }).setLngLat([p.lng, p.lat]).addTo(this.map);
    } else this.me.setLngLat([p.lng, p.lat]);
  }

  setPins(pickup?: LatLng | null, dropoff?: LatLng | null) {
    this.pins.forEach((m) => m.remove());
    this.pins = [];
    const add = (p: LatLng, cls: string, html: string) => {
      const el = document.createElement('div');
      el.className = `pin ${cls}`;
      el.innerHTML = html;
      this.pins.push(new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lng, p.lat]).addTo(this.map));
    };
    if (pickup) add(pickup, 'pin--pickup',
      '<svg viewBox="0 0 36 44" width="36" height="44"><path d="M18 40c0-2-13-15-13-24a13 13 0 0 1 26 0c0 9-13 22-13 24Z" fill="#f9f3e9" stroke="#123b2c" stroke-width="2.5"/><circle cx="18" cy="16" r="5" fill="#176943" stroke="#123b2c" stroke-width="1.5"/></svg>');
    if (dropoff) add(dropoff, 'pin--dropoff',
      '<svg viewBox="0 0 36 44" width="36" height="44"><path d="M18 41c-2-4-14-16-14-25a14 14 0 0 1 28 0c0 9-12 21-14 25Z" fill="#103d2f" stroke="#fff8e9" stroke-width="2.5"/><circle cx="18" cy="16" r="5" fill="#fff8e9"/></svg>');
    if (dropoff) this.pins[this.pins.length - 1].setOffset([0, 0]);
  }

  /** Rota pelas ruas (OSRM); se o serviço não responder, traça a linha direta. */
  async setRoute(a?: LatLng | null, b?: LatLng | null) {
    clearInterval(this.dashTimer);
    if (!a || !b) { this.whenReady(() => (this.map.getSource('route') as GeoJSONSource).setData(EMPTY)); return; }
    let coords: number[][] = [[a.lng, a.lat], [b.lng, b.lat]];
    try {
      const base = import.meta.env.VITE_OSRM_URL ?? 'https://router.project-osrm.org';
      const r = await fetch(`${base}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson`,
        { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (j.routes?.[0]) coords = j.routes[0].geometry.coordinates;
    } catch { /* linha direta */ }
    this.whenReady(() => {
      (this.map.getSource('route') as GeoJSONSource).setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
      if (reduced()) return;
      // Pontilhado que "caminha" na direção da entrega.
      const D = 1.4, G = 1.6, STEPS = 15;
      let i = 0;
      this.dashTimer = window.setInterval(() => {
        i = (i + 1) % STEPS;
        const o = (i / STEPS) * (D + G);
        const dash = o < G ? [0, o, D, G - o] : [o - G, G, D - (o - G), 0];
        if (this.map.getLayer('route')) this.map.setPaintProperty('route', 'line-dasharray', dash);
      }, 80);
    });
  }
}

export const mapctl = new MapCtl();
