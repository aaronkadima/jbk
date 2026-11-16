import { useEffect, useState } from 'react';
import { Sheet } from '../App';
import { useApp, useT, setOnline, acceptOffer, advance, cancelOrder, focusOrder, fail, type Order, type Status } from '../state';
import { money } from '../i18n';
import { Stepper } from './Tracking';

const NEXT: Partial<Record<Status, Status>> = { accepted: 'at_pickup', at_pickup: 'picked_up', picked_up: 'delivered' };

function OfferCard() {
  const tr = useT();
  const lang = useApp((s) => s.lang);
  const offer = useApp((s) => s.offer)!;
  const [left, setLeft] = useState(1);
  useEffect(() => {
    const id = setInterval(() => {
      const k = (offer.until - Date.now()) / (offer.ttl * 1000);
      if (k <= 0) useApp.setState({ offer: null }); else setLeft(k);
    }, 200);
    return () => clearInterval(id);
  }, [offer]);
  return (
    <Sheet title={tr('new_offer')}>
      <div className="timer" aria-hidden="true"><span style={{ transform: `scaleX(${left})` }} /></div>
      <p className="offer__price">{money(lang, offer.price, offer.currency)}</p>
      <p className="hint">{tr('to_pickup', { n: offer.toPickupKm })} · {tr('km', { n: offer.distanceKm })} · {offer.item}</p>
      <ul className="legs legs--quiet">
        <li><span className="legs__mark legs__mark--pickup" aria-hidden="true" /><div><small>{tr('pickup')}</small><p>{offer.pickup.label}</p></div></li>
        <li><span className="legs__mark legs__mark--dropoff" aria-hidden="true" /><div><small>{tr('dropoff')}</small><p>{offer.dropoff.label}</p></div></li>
      </ul>
      <div className="row">
        <button className="btn" onClick={() => useApp.setState({ offer: null })}>{tr('skip')}</button>
        <button className="btn btn--primary grow" onClick={() => acceptOffer().catch(fail)}>{tr('accept')}</button>
      </div>
    </Sheet>
  );
}

function Job({ o }: { o: Order }) {
  const tr = useT();
  const lang = useApp((s) => s.lang);
  const [busy, setBusy] = useState(false);
  const next = NEXT[o.status];
  const dest = o.status === 'picked_up' ? o.dropoff : o.pickup;
  const run = (p: Promise<unknown>) => { setBusy(true); p.catch(fail).finally(() => setBusy(false)); };

  if (!next)
    return (
      <Sheet onClose={() => focusOrder(null)}>
        <div className={`status status--${o.status}`}>
          <div><h2 className="status__title">{tr(`st_${o.status}`)}</h2>
            <p className="status__meta">{tr('order_code', { code: o.code })} · {money(lang, o.price, o.currency)}</p></div>
        </div>
        <button className="btn btn--primary btn--big" onClick={() => focusOrder(null)}>{tr('close')}</button>
      </Sheet>
    );

  return (
    <Sheet>
      <div className="status">
        <div><h2 className="status__title">{dest.label}</h2>
          <p className="status__meta">{tr(o.status === 'picked_up' ? 'dropoff' : 'pickup')} · {o.item} · {money(lang, o.price, o.currency)}</p></div>
      </div>
      <Stepper status={o.status} />
      {o.contact && (
        <div className="who">
          <div className="grow"><strong>{o.contact.name}</strong><small>{tr('order_code', { code: o.code })}</small></div>
          <a className="btn" href={`tel:${o.contact.phone}`}>{tr('call')}</a>
          <a className="btn" target="_blank" rel="noreferrer"
            href={`https://www.google.com/maps/dir/?api=1&destination=${dest.lat},${dest.lng}`}>{tr('open_route')}</a>
        </div>
      )}
      <button className="btn btn--primary btn--big" disabled={busy} onClick={() => run(advance(o.id, next))}>{tr(`act_${next}`)}</button>
      {o.status !== 'picked_up' && (
        <button className="link link--center" disabled={busy} onClick={() => run(cancelOrder(o.id))}>{tr('give_up')}</button>
      )}
    </Sheet>
  );
}

export function CourierPanel() {
  const tr = useT();
  const { user, order, offer, courierOnline } = useApp();
  const c = user!.courier!;
  if (c.status !== 'approved')
    return (
      <Sheet title={tr(c.status === 'pending' ? 'pending_title' : 'rejected_title')}>
        <p className="hint">{tr(c.status === 'pending' ? 'pending_body' : 'rejected_body')}</p>
      </Sheet>
    );
  if (order) return <Job o={order} />;
  if (offer) return <OfferCard />;
  return (
    <div className="dock">
      <p className="dock__count" aria-live="polite">
        <span className={`dot${courierOnline ? ' dot--on' : ''}`} />
        {tr(courierOnline ? 'online_hint' : 'offline_hint')}
      </p>
      <button className={`btn btn--big ${courierOnline ? '' : 'btn--go'}`} onClick={() => setOnline(!courierOnline)}>
        {tr(courierOnline ? 'go_offline' : 'go_online')}
      </button>
      <p className="dock__foot">{tr('deliveries', { n: c.deliveries })}</p>
    </div>
  );
}
