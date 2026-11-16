// Estado do app e toda a conversa com o servidor (REST + Socket.IO).
import { create } from 'zustand';
import { io, type Socket } from 'socket.io-client';
import { mapctl, type CourierPin, type LatLng, type Vehicle } from './map/mapctl';
import { guessLang, translate, errorText, type Lang, type Key } from './i18n';

export type Place = LatLng & { label: string };
export type Status = 'requested' | 'accepted' | 'at_pickup' | 'picked_up' | 'delivered' | 'cancelled' | 'expired';
export type Order = {
  id: string; code: string; status: Status; pickup: Place; dropoff: Place; item: string;
  distanceKm: number; price: number; currency: string;
  courier: null | { id: string; name: string; vehicle: Vehicle; plate?: string; phone?: string };
  createdBy?: string; contact?: { name: string; phone: string };
};
export type Offer = Pick<Order, 'id' | 'code' | 'pickup' | 'dropoff' | 'item' | 'distanceKm' | 'price' | 'currency'> & { toPickupKm: number; ttl: number; until: number };
export type Note = { id: string; type: string; orderId?: string; code?: string; status?: string; read: boolean; createdAt: string };
export type User = {
  id: string; role: 'client' | 'store' | 'courier' | 'admin'; name: string; phone: string; lang: Lang;
  courier?: { vehicle: Vehicle; plate?: string; status: 'pending' | 'approved' | 'rejected'; deliveries: number };
  store?: { name: string; lat: number | null; lng: number | null };
};
export type Draft = { pickup?: Place; dropoff?: Place; item: string; vehicle: Vehicle | null; recipientName: string; recipientPhone: string };
export type View = 'home' | 'request' | 'auth' | 'profile' | 'admin' | 'notes';
type Config = { demo: boolean; vapidKey: string | null; countries: { code: string; currency: string; center: LatLng }[] };

type S = {
  lang: Lang; token: string | null; user: User | null; cfg: Config | null;
  me: LatLng | null; connected: boolean; nearby: number;
  order: Order | null; offer: Offer | null; courierOnline: boolean;
  notes: Note[]; toasts: { id: number; text: string; tone: 'info' | 'good' | 'bad' }[];
  view: View; picking: boolean; draft: Draft; trackCode: string | null; trackMissing: boolean;
};

const emptyDraft = (): Draft => ({ item: '', vehicle: null, recipientName: '', recipientPhone: '' });
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* modo privado */ } },
};

const trackMatch = location.pathname.match(/^\/t\/([A-Za-z0-9]{6})$/);

export const useApp = create<S>(() => ({
  lang: (ls.get('jbk.lang') as Lang) || guessLang(),
  token: ls.get('jbk.token'), user: null, cfg: null,
  me: null, connected: false, nearby: 0,
  order: null, offer: null, courierOnline: false,
  notes: [], toasts: [],
  view: 'home', picking: false, draft: emptyDraft(),
  trackCode: trackMatch ? trackMatch[1].toUpperCase() : null, trackMissing: false,
}));

const get = useApp.getState, set = useApp.setState;
export const t = (key: Key | string, vars?: Record<string, string | number>) => translate(get().lang, key, vars);
export const useT = () => {
  const lang = useApp((s) => s.lang);
  return (key: Key | string, vars?: Record<string, string | number>) => translate(lang, key, vars);
};

let toastId = 0;
export function toast(text: string, tone: 'info' | 'good' | 'bad' = 'info') {
  const id = ++toastId;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), 4500);
}
export const fail = (e: unknown) => toast(errorText(get().lang, e instanceof ApiError ? e.code : 'generic'), 'bad');

// ---------- REST ----------

export class ApiError extends Error { constructor(public code: string) { super(code); } }
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const token = get().token;
  const r = await fetch('/api' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && token && path !== '/auth/login') signOut();
    throw new ApiError(data.error ?? 'generic');
  }
  return data;
}

// ---------- Mapa público ----------

const TERMINAL: Status[] = ['delivered', 'cancelled', 'expired'];
const isLive = (o: Order | null) => !!o && !TERMINAL.includes(o.status);
/** Entregadores livres só aparecem quando não há pedido em foco: tela limpa durante a entrega. */
const showPublic = () => !get().order && get().user?.role !== 'courier' && !get().trackCode;

let socket: Socket;
let watchTimer = 0;
export function watchMap() {
  clearTimeout(watchTimer);
  watchTimer = window.setTimeout(() => {
    if (!socket?.connected || !mapctl.map) return;
    socket.emit('map:watch', mapctl.center(), (list: CourierPin[]) => {
      if (!showPublic()) return;
      mapctl.setCouriers(list);
      set({ nearby: list.length });
    });
  }, 250);
}

function refreshPublic() {
  if (showPublic()) watchMap();
  else { mapctl.setCouriers([]); set({ nearby: 0 }); }
}

// ---------- Pedido em foco ----------

export function focusOrder(o: Order | null, fit = true) {
  const prev = get().order;
  if (prev && prev.id !== o?.id) socket?.emit('order:unwatch', prev.id);
  set({ order: o });
  if (!o) {
    mapctl.setPins(); mapctl.setRoute(); mapctl.setCouriers([]);
    refreshPublic();
    return;
  }
  if (prev?.id !== o.id) {
    mapctl.setCouriers([]);
    mapctl.setPins(o.pickup, o.dropoff);
    mapctl.setRoute(o.pickup, o.dropoff);
    if (fit) mapctl.fit([o.pickup, o.dropoff]);
    const q = get().trackCode ? { code: o.code } : { id: o.id };
    socket?.emit('order:watch', q, (r: { courier?: CourierPin | null }) => {
      if (r?.courier && get().user?.role !== 'courier') mapctl.upsertCourier(r.courier, 'mine');
    });
  }
  if (!isLive(o)) mapctl.setCouriers([]);
}

function onOrderUpdate(raw: Order | { id: string; status: 'released' }) {
  const cur = get().order, me = get().user;
  if (raw.status === 'released') { if (cur?.id === raw.id) focusOrder(null); return; }
  const o = raw as Order;
  if (cur?.id === o.id) {
    // O link público recebe a versão sem dados pessoais: mantém o que já tínhamos.
    focusOrder({ ...cur, ...o }, false);
    if (o.status === 'requested') mapctl.setCouriers([]);
  } else if (!cur && me && (o.createdBy === me.id || o.courier?.id === me.id) && isLive(o)) {
    focusOrder(o);
  }
  if (me?.role === 'courier' && o.status === 'delivered' && me.courier)
    set({ user: { ...me, courier: { ...me.courier, deliveries: me.courier.deliveries + 1 } } });
}

// ---------- Socket ----------

export function connect() {
  socket?.disconnect();
  socket = io({ auth: { token: get().token }, transports: ['websocket', 'polling'] });
  socket.on('connect', () => {
    set({ connected: true });
    const { order, courierOnline, me, trackCode } = get();
    refreshPublic();
    if (order) socket.emit('order:watch', trackCode ? { code: order.code } : { id: order.id }, (r: any) => {
      if (r?.courier && get().user?.role !== 'courier') mapctl.upsertCourier(r.courier, 'mine');
    });
    if (courierOnline && me) socket.emit('courier:online', me);
  });
  socket.on('disconnect', () => set({ connected: false }));
  socket.on('courier:update', (c: CourierPin) => {
    if (!showPublic()) return;
    mapctl.upsertCourier(c);
    set({ nearby: mapctl.courierIds().length });
  });
  socket.on('courier:gone', (id: string) => {
    if (!showPublic()) return;
    mapctl.removeCourier(id);
    set({ nearby: mapctl.courierIds().length });
  });
  socket.on('order:courier', (c: CourierPin) => {
    if (get().user?.role !== 'courier' && isLive(get().order)) mapctl.upsertCourier(c, 'mine');
  });
  socket.on('order:update', onOrderUpdate);
  socket.on('order:offer', (o: Omit<Offer, 'until'>) => {
    if (get().order) return;
    set({ offer: { ...o, until: Date.now() + o.ttl * 1000 } });
    navigator.vibrate?.([120, 60, 120]);
    systemNotify(t('new_offer'), `${o.pickup.label} → ${o.dropoff.label}`);
  });
  socket.on('order:taken', (id: string) => {
    if (get().offer?.id === id) { set({ offer: null }); toast(t('offer_gone')); }
  });
  socket.on('notify', (n: Note) => {
    set((s) => ({ notes: [n, ...s.notes] }));
    const text = noteText(n);
    toast(text, n.status === 'delivered' || n.type === 'courier_approved' ? 'good' : n.status === 'cancelled' || n.status === 'expired' ? 'bad' : 'info');
    systemNotify(n.code ? `JBK · ${n.code}` : 'JBK', text);
    if (n.type.startsWith('courier_')) api('/me').then((r) => set({ user: r.user })).catch(() => {});
  });
}

export const noteText = (n: Note) => (n.type === 'order_status' ? t(`st_${n.status}`) : t(`n_${n.type}`));

// ---------- Notificações do sistema ----------

function systemNotify(title: string, body: string) {
  if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
  navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, { body, icon: '/icon-192.png', tag: title })).catch(() => {});
}

/** Pede permissão num momento em que faz sentido (ao criar pedido ou ficar online). */
export async function enableNotifications() {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
  if (Notification.permission === 'default') await Notification.requestPermission();
  if (Notification.permission !== 'granted') return;
  const key = get().cfg?.vapidKey;
  if (!key || !get().token) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    await api('/push/subscribe', sub.toJSON());
  } catch { /* push indisponível neste navegador */ }
}

// ---------- Sessão ----------

export async function boot() {
  const cfg = await api<Config>('/config').catch(() => null);
  set({ cfg });
  const { trackCode, token } = get();
  if (trackCode) {
    connect();
    try { focusOrder(await api<Order>(`/track/${trackCode}`)); } catch { set({ trackMissing: true }); }
    return;
  }
  if (token) {
    try {
      const r = await api<{ user: User; order: Order | null }>('/me');
      set({ user: r.user });
      if (!ls.get('jbk.lang')) set({ lang: r.user.lang });
      connect();
      if (r.order) focusOrder(r.order);
      loadNotes();
      if (r.user.role === 'courier' && ls.get('jbk.online') === '1') setOnline(true, true);
      return;
    } catch { /* token inválido: segue como visitante */ }
  }
  connect();
}

const loadNotes = () => api<Note[]>('/notifications').then((notes) => set({ notes })).catch(() => {});

export async function signIn(mode: 'login' | 'register', body: Record<string, unknown>) {
  const r = await api<{ token: string; user: User }>(`/auth/${mode}`, { ...body, lang: get().lang });
  ls.set('jbk.token', r.token);
  set({ token: r.token, user: r.user });
  connect();
  loadNotes();
  const me = await api<{ order: Order | null }>('/me');
  if (me.order) focusOrder(me.order);
  // Quem estava montando um pedido volta para ele; os demais vão para o mapa.
  const d = get().draft;
  set({ view: d.pickup && d.dropoff && r.user.role !== 'courier' && r.user.role !== 'admin' ? 'request' : 'home' });
  refreshPublic();
}

export function signOut() {
  if (get().courierOnline) setOnline(false);
  ls.set('jbk.token', null); ls.set('jbk.online', null);
  set({ token: null, user: null, order: null, offer: null, notes: [], view: 'home', draft: emptyDraft() });
  mapctl.setPins(); mapctl.setRoute(); mapctl.setCouriers([]);
  connect();
}

export function setLang(lang: Lang) {
  ls.set('jbk.lang', lang);
  set({ lang });
  document.documentElement.lang = lang;
  if (get().token) api('/me/lang', { lang }).catch(() => {});
}

export const go = (view: View) => set({ view, picking: false });
export const patchDraft = (d: Partial<Draft>) => set((s) => ({ draft: { ...s.draft, ...d } }));
export const resetDraft = () => set({ draft: emptyDraft() });

// ---------- Ações de pedido ----------

export async function submitOrder() {
  const d = get().draft;
  const o = await api<Order>('/orders', {
    pickup: d.pickup, dropoff: d.dropoff, item: d.item, vehicle: d.vehicle,
    recipientName: d.recipientName, recipientPhone: d.recipientPhone,
  });
  set({ view: 'home', draft: emptyDraft() });
  focusOrder(o);
  enableNotifications();
}

export const cancelOrder = (id: string) => api<Order>(`/orders/${id}/cancel`, {}).then(onOrderUpdate);
export const advance = (id: string, status: Status) => api<Order>(`/orders/${id}/status`, { status }).then(onOrderUpdate);
export async function acceptOffer() {
  const offer = get().offer;
  if (!offer) return;
  set({ offer: null });
  focusOrder(await api<Order>(`/orders/${offer.id}/accept`, {}));
}

// ---------- Localização e modo entregador ----------

let wake: { release: () => Promise<void> } | null = null;
let lastSent = 0;

export function setOnline(on: boolean, silent = false) {
  const me = get().me;
  if (!on) {
    socket?.emit('courier:offline');
    set({ courierOnline: false, offer: null });
    ls.set('jbk.online', null);
    wake?.release().catch(() => {}); wake = null;
    return;
  }
  if (!me) {
    // Sem posição ainda: fica marcado e entra no mapa assim que o GPS responder.
    ls.set('jbk.online', '1');
    if (!silent) toast(t('need_gps'), 'bad');
    return;
  }
  socket.emit('courier:online', me, (r: { ok?: boolean; error?: string }) => {
    if (!r?.ok) { if (!silent) toast(errorText(get().lang, r?.error ?? 'generic'), 'bad'); ls.set('jbk.online', null); return; }
    set({ courierOnline: true });
    ls.set('jbk.online', '1');
    enableNotifications();
    // Mantém a tela acesa: o navegador para o GPS quando o aparelho bloqueia.
    (navigator as any).wakeLock?.request('screen').then((w: any) => { wake = w; }).catch(() => {});
  });
}

export function startGeolocation(onFirst: (p: LatLng | null) => void) {
  let first = true;
  if (!navigator.geolocation) { onFirst(null); return; }
  navigator.geolocation.watchPosition(
    (pos) => {
      const p = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      set({ me: p });
      mapctl.setMe(p);
      if (first) { first = false; onFirst(p); }
      const s = get();
      if (s.user?.role === 'courier') {
        if (!s.courierOnline && ls.get('jbk.online') === '1' && socket?.connected) setOnline(true, true);
        if (s.courierOnline && Date.now() - lastSent > 1500) {
          lastSent = Date.now();
          const h = pos.coords.heading;
          socket.emit('courier:pos', { ...p, heading: h !== null && Number.isFinite(h) && (pos.coords.speed ?? 0) > 0.5 ? h : undefined });
        }
      }
    },
    () => { if (first) { first = false; onFirst(null); } },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 12000 },
  );
}
