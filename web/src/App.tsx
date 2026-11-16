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
    <button className="compass" aria-label={tr('recenter')} onClick={() => mapctl.flyTo(me ?? CITIES.CD, 15.5)} title={tr('recenter')}>
      <svg viewBox="0 0 84 92" width="76" height="84" fill="none" aria-hidden="true">
        <g stroke="#182c23" strokeWidth="1.35" strokeLinejoin="round">
          <circle cx="42" cy="46" r="24" strokeWidth=".7" strokeDasharray="1 5"/>
          <path d="M42 6 48 39 78 46 48 52 42 86 36 52 6 46 36 39Z" fill="#f5e5be"/>
          <path d="M42 6 48 39 42 46Z" fill="#173d2c"/>
          <path d="M78 46 48 52 42 46Z" fill="#173d2c"/>
          <path d="M42 86 36 52 42 46Z" fill="#173d2c"/>
          <path d="M6 46 36 39 42 46Z" fill="#173d2c"/>
          <circle cx="42" cy="46" r="3" fill="#b98258"/>
        </g>
        <g fontFamily="Georgia, serif" fontSize="13" fontWeight="bold" textAnchor="middle" fill="#173d2c">
          <text x="42" y="11">N</text><text x="42" y="92">S</text><text x="2" y="49">O</text><text x="82" y="49">L</text>
        </g>
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

function Glyph({ name, size = 24 }: { name: 'pin' | 'package' | 'arrow'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  if (name === 'pin') return <svg {...common}><path d="M20 10c0 5.4-8 12-8 12S4 15.4 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.8"/></svg>;
  if (name === 'package') return <svg {...common}><path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10M7.5 4.5l9 5"/></svg>;
  return <svg {...common}><path d="M4 12h16m-7-7 7 7-7 7"/></svg>;
}

function DesktopSidebar() {
  const tr = useT();
  const nearby = useApp((s) => s.nearby);
  const user = useApp((s) => s.user);
  return (
    <aside className="sidebar" aria-label="JBK">
      <div className="sidebar__content">
        <button className="sidebar__logo" onClick={() => go('home')} aria-label="JBK, início">JBK</button>
        <h1 className="sidebar__headline">{tr('nearby_heading')}</h1>
        <p className="sidebar__location"><Glyph name="pin" size={23} /> Kinshasa, RDC</p>
        <button className="sidebar__cta" onClick={() => go(user?.role === 'admin' ? 'admin' : 'request')}>
          <Glyph name="package" size={29} /> <span className="sidebar__cta-label">{user?.role === 'store' ? tr('ask_store') : tr('ask')}</span> <Glyph name="arrow" size={23} />
        </button>
        <div className="sidebar__vehicles" aria-label="Opções de transporte">
          <button onClick={() => go('request')}><span className="sidebar__vehicle-icon" dangerouslySetInnerHTML={{ __html: icon('moto', 29) }} /><span>{tr('moto')}</span><Glyph name="arrow" size={19}/></button>
          <button onClick={() => go('request')}><span className="sidebar__vehicle-icon" dangerouslySetInnerHTML={{ __html: icon('bike', 29) }} /><span>{tr('bike')}</span><Glyph name="arrow" size={19}/></button>
        </div>
        <div className="sidebar__availability" aria-live="polite"><span className={nearby ? 'dot dot--on' : 'dot'} />{nearby === 0 ? tr('nearby_0') : nearby === 1 ? tr('nearby_1') : tr('nearby_n', { n: nearby })}</div>
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
    const city = CITIES.CD;
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
