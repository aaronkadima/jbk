import { useEffect, useState, type FormEvent } from 'react';
import { Sheet, CITIES } from '../App';
import { mapctl, icon, type Vehicle } from '../map/mapctl';
import { useApp, useT, api, go, signIn, signOut, setLang, focusOrder, noteText, fail, ApiError, type Order, type User } from '../state';
import { LANGS, errorText, money } from '../i18n';

const VEHICLES: Vehicle[] = ['foot', 'bike', 'moto', 'car'];
type Role = 'client' | 'store' | 'courier';

export function AuthSheet() {
  const tr = useT();
  const lang = useApp((s) => s.lang);
  const hasDraft = useApp((s) => !!s.draft.pickup);
  const [mode, setMode] = useState<'login' | 'register'>(hasDraft ? 'register' : 'login');
  const [role, setRole] = useState<Role>('client');
  const [f, setF] = useState({ name: '', phone: '', password: '', storeName: '', plate: '' });
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const on = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setErr(''); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await signIn(mode, mode === 'login' ? { phone: f.phone, password: f.password }
        : { ...f, role, vehicle, storeAt: role === 'store' ? useApp.getState().me ?? mapctl.center() : undefined });
    } catch (e2) {
      setErr(errorText(lang, e2 instanceof ApiError ? e2.code : 'generic'));
      setBusy(false);
    }
  };

  return (
    <Sheet title={tr(mode)} onClose={() => go(hasDraft ? 'request' : 'home')}>
      <form className="form" onSubmit={submit}>
        {mode === 'register' && (
          <>
            <p className="label" id="role">{tr('i_am')}</p>
            <div className="chips" role="radiogroup" aria-labelledby="role">
              {(['client', 'store', 'courier'] as Role[]).map((r) => (
                <button type="button" key={r} role="radio" aria-checked={role === r} className="chip" onClick={() => setRole(r)}>{tr(`role_${r}`)}</button>
              ))}
            </div>
            <input className="field" value={f.name} onChange={on('name')} placeholder={tr('name')} aria-label={tr('name')} autoComplete="name" required />
          </>
        )}
        <input className="field" type="tel" value={f.phone} onChange={on('phone')} placeholder={tr('phone_ph')} aria-label={tr('phone')} autoComplete="tel" required />
        <input className="field" type="password" value={f.password} onChange={on('password')} placeholder={tr('password')} aria-label={tr('password')}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={6} />
        {mode === 'register' && role === 'store' && (
          <>
            <input className="field" value={f.storeName} onChange={on('storeName')} placeholder={tr('store_name')} aria-label={tr('store_name')} required />
            <p className="hint">{tr('store_here')}</p>
          </>
        )}
        {mode === 'register' && role === 'courier' && (
          <>
            <p className="label" id="veh">{tr('vehicle')}</p>
            <div className="chips" role="radiogroup" aria-labelledby="veh">
              {VEHICLES.map((v) => (
                <button type="button" key={v} role="radio" aria-checked={vehicle === v} className="chip" onClick={() => { setVehicle(v); setErr(''); }}>
                  <span dangerouslySetInnerHTML={{ __html: icon(v, 18) }} />{tr(v)}
                </button>
              ))}
            </div>
            {(vehicle === 'moto' || vehicle === 'car') && (
              <input className="field" value={f.plate} onChange={on('plate')} placeholder={tr('plate')} aria-label={tr('plate')} maxLength={16} />
            )}
          </>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn btn--primary btn--big" disabled={busy}>{tr(mode === 'login' ? 'login' : 'create_account')}</button>
        <button type="button" className="link link--center" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
          {tr(mode === 'login' ? 'no_account' : 'have_account')}
        </button>
      </form>
    </Sheet>
  );
}

export function ProfileSheet() {
  const tr = useT();
  const { user, lang } = useApp();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const showOrders = user && user.role !== 'admin';
  useEffect(() => { if (showOrders) api<Order[]>('/orders').then(setOrders).catch(() => setOrders([])); }, []);
  if (!user) return null;
  return (
    <Sheet title={user.name} onClose={() => go('home')}>
      <p className="hint">{tr(user.role === 'admin' ? 'admin' : `role_${user.role}`)} · {user.phone}</p>

      <p className="label" id="lang">{tr('language')}</p>
      <div className="chips" role="radiogroup" aria-labelledby="lang">
        {LANGS.map((l) => (
          <button key={l.code} role="radio" aria-checked={lang === l.code} className="chip" onClick={() => setLang(l.code)}>{l.label}</button>
        ))}
      </div>

      <p className="label">{tr('go_to')}</p>
      <div className="chips">
        {Object.values(CITIES).map((c) => (
          <button key={c.name} className="chip" onClick={() => { mapctl.flyTo(c, 13.5); go('home'); }}>{c.name}</button>
        ))}
      </div>

      {showOrders && (
        <>
          <p className="label">{tr('my_orders')}</p>
          {orders && orders.length === 0 && <p className="hint">{tr('no_orders')}</p>}
          <ul className="list">
            {orders?.slice(0, 8).map((o) => (
              <li key={o.id}>
                <button onClick={() => { focusOrder(null); focusOrder(o); go('home'); }}>
                  <span><strong>{o.code}</strong> {o.item}</span>
                  <small>{tr(`st_${o.status}`)} · {money(lang, o.price, o.currency)}</small>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <button className="btn btn--big" onClick={signOut}>{tr('sign_out')}</button>
    </Sheet>
  );
}

type Applicant = { id: string; name: string; phone: string; vehicle: Vehicle; plate?: string; status: string; deliveries: number };

export function AdminSheet() {
  const tr = useT();
  const [tab, setTab] = useState<'pending' | 'approved'>('pending');
  const [rows, setRows] = useState<Applicant[] | null>(null);
  const load = () => api<Applicant[]>(`/admin/couriers?status=${tab}`).then(setRows).catch(fail);
  useEffect(() => { setRows(null); load(); }, [tab]);
  const act = (id: string, action: 'approve' | 'reject') => api(`/admin/couriers/${id}/${action}`, {}).then(load).catch(fail);
  return (
    <Sheet title={tr('admin')} onClose={() => go('home')}>
      <div className="chips" role="tablist">
        {(['pending', 'approved'] as const).map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} aria-checked={tab === x} className="chip" onClick={() => setTab(x)}>{tr(`tab_${x}`)}</button>
        ))}
      </div>
      {rows && rows.length === 0 && <p className="hint">{tr(tab === 'pending' ? 'none_pending' : 'none_approved')}</p>}
      <ul className="list">
        {rows?.map((r) => (
          <li key={r.id} className="list__row">
            <span className="who__seal" dangerouslySetInnerHTML={{ __html: icon(r.vehicle, 22) }} />
            <div className="grow">
              <strong>{r.name}</strong>
              <small>{r.phone} · {tr(r.vehicle)}{r.plate ? ` · ${r.plate}` : ''}</small>
            </div>
            {tab === 'pending' && <button className="btn btn--go" onClick={() => act(r.id, 'approve')}>{tr('approve')}</button>}
            <button className="btn btn--danger" onClick={() => act(r.id, 'reject')}>{tr('reject')}</button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export function NotesSheet() {
  const tr = useT();
  const notes = useApp((s) => s.notes);
  const lang = useApp((s) => s.lang);
  useEffect(() => () => {
    // Marca como lidos ao fechar, para o destaque continuar visível enquanto a lista está aberta.
    if (useApp.getState().notes.some((n) => !n.read)) {
      api('/notifications/read', {}).catch(() => {});
      useApp.setState((s) => ({ notes: s.notes.map((n) => ({ ...n, read: true })) }));
    }
  }, []);
  const when = (iso: string) => new Date(iso).toLocaleString(lang, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <Sheet title={tr('notifications')} onClose={() => go('home')}>
      {notes.length === 0 && <p className="hint">{tr('no_notes')}</p>}
      <ul className="list">
        {notes.map((n) => (
          <li key={n.id} className={`list__row${n.read ? '' : ' is-new'}`}>
            <div className="grow">
              <strong>{noteText(n)}</strong>
              <small>{n.code ? `${tr('order_code', { code: n.code })} · ` : ''}{when(n.createdAt)}</small>
            </div>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

export type { User };
