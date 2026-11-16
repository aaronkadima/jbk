import { useEffect, useRef, useState } from 'react';
import { Sheet } from '../App';
import { mapctl, icon, type LatLng, type Vehicle } from '../map/mapctl';
import { useApp, useT, api, go, patchDraft, resetDraft, submitOrder, fail, ApiError, type Place } from '../state';
import { errorText, money } from '../i18n';

const NOMINATIM = import.meta.env.VITE_GEOCODER_URL ?? 'https://nominatim.openstreetmap.org';
const VEHICLES: Vehicle[] = ['foot', 'bike', 'moto', 'car'];

async function search(q: string, lang: string, signal: AbortSignal): Promise<Place[]> {
  const c = mapctl.center();
  const box = `${c.lng - 0.4},${c.lat + 0.4},${c.lng + 0.4},${c.lat - 0.4}`;
  const r = await fetch(`${NOMINATIM}/search?format=jsonv2&limit=4&countrycodes=cd,br,us&viewbox=${box}&accept-language=${lang}&q=${encodeURIComponent(q)}`, { signal });
  const list = (await r.json()) as { lat: string; lon: string; display_name: string }[];
  return list.map((x) => ({ lat: +x.lat, lng: +x.lon, label: x.display_name.split(',').slice(0, 3).join(',') }));
}

async function nameOf(p: LatLng, lang: string): Promise<string> {
  try {
    const r = await fetch(`${NOMINATIM}/reverse?format=jsonv2&zoom=18&accept-language=${lang}&lat=${p.lat}&lon=${p.lng}`, { signal: AbortSignal.timeout(2500) });
    const j = await r.json();
    const a = j.address ?? {};
    const street = [a.road ?? a.pedestrian ?? j.name, a.house_number].filter(Boolean).join(', ');
    const area = a.suburb ?? a.neighbourhood ?? a.city_district ?? a.city ?? a.town;
    const label = [street, area].filter(Boolean).join(' · ');
    if (label) return label;
  } catch { /* sem geocodificador: usa as coordenadas */ }
  return `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
}

function PickStep({ kind, onDone }: { kind: 'pickup' | 'dropoff'; onDone: (p: Place) => void }) {
  const tr = useT();
  const lang = useApp((s) => s.lang);
  const me = useApp((s) => s.me);
  const store = useApp((s) => s.user?.store);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Place[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    useApp.setState({ picking: true });
    mapctl.map.easeTo({ padding: { top: 0, left: 0, right: 0, bottom: 250 }, duration: 0 });
    if (kind === 'dropoff' && me && useApp.getState().user?.role !== 'store') mapctl.flyTo(me, 16);
    return () => {
      useApp.setState({ picking: false });
      mapctl.map.easeTo({ padding: { top: 0, left: 0, right: 0, bottom: 0 }, duration: 0 });
    };
  }, [kind]);

  useEffect(() => {
    if (q.trim().length < 3) { setHits([]); return; }
    const ac = new AbortController();
    const id = setTimeout(() => search(q, lang, ac.signal).then(setHits).catch(() => {}), 600);
    return () => { clearTimeout(id); ac.abort(); };
  }, [q, lang]);

  const confirm = async () => {
    setBusy(true);
    const p = mapctl.center();
    onDone({ ...p, label: await nameOf(p, lang) });
  };
  const storeAt = store?.lat != null && store.lng != null ? { lat: store.lat, lng: store.lng as number } : null;

  return (
    <Sheet title={tr(kind === 'pickup' ? 'where_pickup' : 'where_dropoff')} onClose={() => go('home')} tight>
      <input className="field" type="search" value={q} onChange={(e) => setQ(e.target.value)}
        placeholder={tr('search_place')} aria-label={tr('search_place')} />
      {hits.length > 0 ? (
        <ul className="hits">
          {hits.map((h, i) => (
            <li key={i}><button onClick={() => { mapctl.flyTo(h, 17); setHits([]); setQ(''); }}>{h.label}</button></li>
          ))}
        </ul>
      ) : <p className="hint">{tr('move_map')}</p>}
      <div className="row">
        {kind === 'pickup' && storeAt && (
          <button className="btn" onClick={() => mapctl.flyTo(storeAt, 17)}>{tr('use_my_store')}</button>
        )}
        {kind === 'dropoff' && me && (
          <button className="btn" onClick={() => mapctl.flyTo(me, 17)}>{tr('use_my_location')}</button>
        )}
        <button className="btn btn--primary grow" disabled={busy} onClick={confirm}>
          {tr(kind === 'pickup' ? 'pickup_here' : 'dropoff_here')}
        </button>
      </div>
    </Sheet>
  );
}

export function RequestSheet() {
  const tr = useT();
  const { draft, user, lang } = useApp();
  const [step, setStep] = useState<'pickup' | 'dropoff' | 'details'>(
    draft.pickup && draft.dropoff ? 'details' : draft.pickup ? 'dropoff' : 'pickup');
  const [quote, setQuote] = useState<{ price: number; currency: string; distanceKm: number } | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  // Loja com endereço cadastrado: a coleta já vem preenchida e o fluxo começa na entrega.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const st = user?.store;
    if (!draft.pickup && st?.lat != null && st.lng != null) {
      patchDraft({ pickup: { lat: st.lat, lng: st.lng, label: st.name } });
      setStep('dropoff');
    }
  }, []);

  useEffect(() => {
    if (step !== 'details' || !draft.pickup || !draft.dropoff) return;
    mapctl.setPins(draft.pickup, draft.dropoff);
    mapctl.setRoute(draft.pickup, draft.dropoff);
    mapctl.fit([draft.pickup, draft.dropoff], 460);
    return () => { if (!useApp.getState().order) { mapctl.setPins(); mapctl.setRoute(); } };
  }, [step, draft.pickup, draft.dropoff]);

  useEffect(() => {
    if (step !== 'details') return;
    setQuote(null); setErr('');
    api('/quote', { pickup: draft.pickup, dropoff: draft.dropoff, vehicle: draft.vehicle })
      .then(setQuote)
      .catch((e) => setErr(errorText(lang, e instanceof ApiError ? e.code : 'generic')));
  }, [step, draft.pickup, draft.dropoff, draft.vehicle, lang]);

  if (step === 'pickup') return <PickStep key="pickup" kind="pickup" onDone={(p) => { patchDraft({ pickup: p }); setStep(draft.dropoff ? 'details' : 'dropoff'); }} />;
  if (step === 'dropoff') return <PickStep key="dropoff" kind="dropoff" onDone={(p) => { patchDraft({ dropoff: p }); setStep('details'); }} />;

  const send = async () => {
    if (!draft.item.trim()) { setErr(errorText(lang, 'item_required')); return; }
    if (!user) { go('auth'); return; }
    setBusy(true);
    try { await submitOrder(); } catch (e) { fail(e); setBusy(false); }
  };

  return (
    <Sheet title={tr(user?.role === 'store' ? 'ask_store' : 'ask')} onClose={() => { resetDraft(); go('home'); }}>
      <ul className="legs">
        <li>
          <span className="legs__mark legs__mark--pickup" aria-hidden="true" />
          <div><small>{tr('pickup')}</small><p>{draft.pickup!.label}</p></div>
          <button className="link" onClick={() => setStep('pickup')}>{tr('change')}</button>
        </li>
        <li>
          <span className="legs__mark legs__mark--dropoff" aria-hidden="true" />
          <div><small>{tr('dropoff')}</small><p>{draft.dropoff!.label}</p></div>
          <button className="link" onClick={() => setStep('dropoff')}>{tr('change')}</button>
        </li>
      </ul>

      <label className="label" htmlFor="item">{tr('what_item')}</label>
      <input id="item" className="field" value={draft.item} maxLength={200} placeholder={tr('item_ph')}
        onChange={(e) => { patchDraft({ item: e.target.value }); setErr(''); }} />

      {user?.role === 'store' && (
        <div className="row">
          <input className="field grow" value={draft.recipientName} placeholder={tr('recipient_name')} aria-label={tr('recipient_name')}
            onChange={(e) => patchDraft({ recipientName: e.target.value })} />
          <input className="field grow" type="tel" value={draft.recipientPhone} placeholder={tr('recipient_phone')} aria-label={tr('recipient_phone')}
            onChange={(e) => patchDraft({ recipientPhone: e.target.value })} />
        </div>
      )}

      <p className="label" id="carry">{tr('how_carry')}</p>
      <div className="chips" role="radiogroup" aria-labelledby="carry">
        <button role="radio" aria-checked={draft.vehicle === null} className="chip" onClick={() => patchDraft({ vehicle: null })}>{tr('any')}</button>
        {VEHICLES.map((v) => (
          <button key={v} role="radio" aria-checked={draft.vehicle === v} className="chip" onClick={() => patchDraft({ vehicle: v })}>
            <span dangerouslySetInnerHTML={{ __html: icon(v, 18) }} />{tr(v)}
          </button>
        ))}
      </div>

      {err && <p className="error" role="alert">{err}</p>}
      {!user && <p className="hint">{tr('login_to_order')}</p>}
      <button className="btn btn--primary btn--big" disabled={busy || !quote} onClick={send}>
        <span>{user ? tr('call_courier') : tr('sign_in')}</span>
        {quote && <span className="btn__price">{money(lang, quote.price, quote.currency)} · {tr('km', { n: quote.distanceKm })}</span>}
      </button>
    </Sheet>
  );
}
