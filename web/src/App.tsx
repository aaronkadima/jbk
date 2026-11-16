import { useEffect, useRef, type ReactNode } from 'react';
import { mapctl, icon, type LatLng } from './map/mapctl';
import { useApp, useT, boot, go, startGeolocation, watchMap, toast, t } from './state';
import { RequestSheet } from './ui/Request';
import { Tracking } from './ui/Tracking';
import { CourierPanel } from './ui/Courier';
import { AuthSheet, ProfileSheet, AdminSheet, NotesSheet } from './ui/Account';

export const CITIES: Record<string, LatLng & { name: string }> = {
  CD: { name: 'Kinshasa', lat: -4.3224, lng: 15.307 },
  BR: { name: 'São Paulo', lat: -23.5505, lng: -46.6333 },
  US: { name: 'New York', lat: 40.7128, lng: -74.006 },
};

export function Sheet({ title, onClose, children, tight }: { title?: string; onClose?: () => void; children: ReactNode; tight?: boolean }) {
  const tr = useT();
  return (
    <section className={`sheet${tight ? ' sheet--tight' : ''}`}>
      {(title || onClose) && (
        <header className="sheet__head">
          {title && <h2>{title}</h2>}
          {onClose && <button className="iconbtn" onClick={onClose} aria-label={tr('close')}>✕</button>}
        </header>
      )}
      {children}
    </section>
  );
}

function Compass() {
  const tr = useT();
  const me = useApp((s) => s.me);
  return (
    <button className="compass" aria-label={tr('recenter')} disabled={!me} onClick={() => me && mapctl.flyTo(me, 15.5)}>
      <svg viewBox="0 0 64 64" width="52" height="52" aria-hidden="true">
        <circle cx="32" cy="32" r="29" fill="#F6EDD6" stroke="#2B1D12" strokeWidth="2.5" />
        <circle cx="32" cy="32" r="23" fill="none" stroke="#2B1D12" strokeWidth="1" strokeDasharray="1.5 4" />
        <path d="M32 6l6 20 20 6-20 6-6 20-6-20-20-6 20-6z" fill="#F6EDD6" stroke="#2B1D12" strokeWidth="2" strokeLinejoin="round" />
        <path d="M32 6l6 20-6 6z" fill="#D8402A" stroke="#2B1D12" strokeWidth="2" strokeLinejoin="round" />
        <path d="M32 58l-6-20 6-6z" fill="#2438C8" stroke="#2B1D12" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="32" cy="32" r="3" fill="#E0A526" stroke="#2B1D12" strokeWidth="1.5" />
      </svg>
    </button>
  );
}

function TopBar() {
  const tr = useT();
  const user = useApp((s) => s.user);
  const unread = useApp((s) => s.notes.filter((n) => !n.read).length);
  return (
    <header className="top">
      <button className="brand" onClick={() => go('home')} aria-label="JBK">JBK</button>
      <div className="top__right">
        {user && (
          <button className="iconbtn iconbtn--float" onClick={() => go('notes')} aria-label={tr('notifications')}>
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6 16V11a6 6 0 1112 0v5l2 2H4zM10 21h4" />
            </svg>
            {unread > 0 && <span className="badge">{unread > 9 ? '9+' : unread}</span>}
          </button>
        )}
        <button className="iconbtn iconbtn--float iconbtn--wide" onClick={() => go(user ? 'profile' : 'auth')}>
          {user ? user.name.slice(0, 1).toUpperCase() : tr('sign_in')}
        </button>
      </div>
    </header>
  );
}

function KinshasaArt() {
  return <div className="sidebar__art" aria-hidden="true" />;
}

function DesktopSidebar() {
  const tr = useT();
  const nearby = useApp((s) => s.nearby);
  const user = useApp((s) => s.user);
  const city = useApp((s) => s.lang === 'fr' ? 'Kinshasa, RDC' : s.lang === 'pt' ? 'São Paulo, Brasil' : 'New York, USA');
  return (
    <aside className="sidebar" aria-label="JBK">
      <div className="sidebar__content">
        <button className="sidebar__logo" onClick={() => go('home')} aria-label="JBK, início">JBK</button>
        <h1 className="sidebar__headline">{useApp.getState().lang === 'fr' ? 'Livraisons à proximité' : useApp.getState().lang === 'en' ? 'Deliveries nearby' : 'Entregas por perto'}</h1>
        <p className="sidebar__location"><span aria-hidden="true">⌖</span> {city}</p>
        <button className="sidebar__cta" onClick={() => go(user?.role === 'admin' ? 'admin' : 'request')}>
          <span aria-hidden="true">⬡</span> {user?.role === 'store' ? tr('ask_store') : tr('ask')} <span aria-hidden="true">→</span>
        </button>
        <div className="sidebar__availability" aria-live="polite"><span className={nearby ? 'dot dot--on' : 'dot'} />{nearby === 0 ? tr('nearby_0') : nearby === 1 ? tr('nearby_1') : tr('nearby_n', { n: nearby })}</div>
        <div className="sidebar__vehicles" aria-label="Opções de transporte">
          <button onClick={() => go('request')}>♧ <span>{tr('moto')}</span><span>→</span></button>
          <button onClick={() => go('request')}>♧ <span>{tr('bike')}</span><span>→</span></button>
        </div>
      </div>
      <KinshasaArt />
    </aside>
  );
}

function Home() {
  const tr = useT();
  const user = useApp((s) => s.user);
  const nearby = useApp((s) => s.nearby);
  if (user?.role === 'admin')
    return (
      <div className="dock">
        <button className="btn btn--primary btn--big" onClick={() => go('admin')}>{tr('admin')}</button>
      </div>
    );
  return (
    <div className="dock">
      <p className="dock__count" aria-live="polite">
        <span className={`dot${nearby ? ' dot--on' : ''}`} />
        {nearby === 0 ? tr('nearby_0') : nearby === 1 ? tr('nearby_1') : tr('nearby_n', { n: nearby })}
      </p>
      <button className="btn btn--primary btn--big" onClick={() => go('request')}>
        {user?.role === 'store' ? tr('ask_store') : tr('ask')}
      </button>
    </div>
  );
}

function PublicTrack() {
  const tr = useT();
  const order = useApp((s) => s.order);
  const missing = useApp((s) => s.trackMissing);
  if (order) return <Tracking order={order} readOnly />;
  if (!missing) return null;
  return (
    <Sheet title={tr('track_not_found')}>
      <a className="btn btn--primary btn--big" href="/">{tr('open_app')}</a>
    </Sheet>
  );
}

export default function App() {
  const el = useRef<HTMLDivElement>(null);
  const tr = useT();
  const s = useApp();

  useEffect(() => {
    const lang = useApp.getState().lang;
    const city = CITIES[lang === 'fr' ? 'CD' : lang === 'pt' ? 'BR' : 'US'];
    const map = mapctl.mount(el.current!, city, 13.5);
    map.on('moveend', watchMap);
    mapctl.onCourierTap = (c) => toast(`${c.name} · ${t(c.vehicle)}`);
    startGeolocation((p) => {
      if (p) { if (!useApp.getState().order) mapctl.flyTo(p, 14.5); }
      else if (!useApp.getState().trackCode) toast(t('geo_off', { city: city.name }));
    });
    boot();
  }, []);

  const role = s.user?.role;
  let body: ReactNode;
  if (s.trackCode) body = <PublicTrack />;
  else if (s.view === 'auth') body = <AuthSheet />;
  else if (s.view === 'profile') body = <ProfileSheet />;
  else if (s.view === 'notes') body = <NotesSheet />;
  else if (s.view === 'admin' && role === 'admin') body = <AdminSheet />;
  else if (role === 'courier') body = <CourierPanel />;
  else if (s.order) body = <Tracking order={s.order} />;
  else if (s.view === 'request') body = <RequestSheet />;
  else body = <Home />;

  return (
    <div className="app">
      {!s.trackCode && <DesktopSidebar />}
      <div ref={el} className="map" />
      <div className="grain" aria-hidden="true" />
      {s.picking && (
        <div className="crosshair" aria-hidden="true">
          <svg viewBox="0 0 44 56" width="44" height="56">
            <path d="M22 54C22 54 4 32 4 20a18 18 0 0136 0c0 12-18 34-18 34z" fill="#2438C8" stroke="#2B1D12" strokeWidth="3" strokeLinejoin="round" />
            <circle cx="22" cy="20" r="6" fill="#F6EDD6" stroke="#2B1D12" strokeWidth="3" />
          </svg>
        </div>
      )}
      {!s.trackCode && <TopBar />}
      {s.trackCode && <a className="brand brand--solo" href="/">JBK</a>}
      <Compass />
      <div className="toasts" role="status" aria-live="polite">
        {!s.connected && <div className="toast toast--bad">{tr('offline_net')}</div>}
        {s.toasts.map((x) => <div key={x.id} className={`toast toast--${x.tone}`}>{x.text}</div>)}
      </div>
      {s.cfg?.demo && s.view === 'home' && !s.order && role !== 'courier' && !s.trackCode && (
        <p className="demo">{tr('demo_badge')}</p>
      )}
      {body}
    </div>
  );
}

export { icon };
