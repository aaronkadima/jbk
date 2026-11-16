import { useState } from 'react';
import { Sheet } from '../App';
import { icon } from '../map/mapctl';
import { useApp, useT, cancelOrder, focusOrder, go, patchDraft, toast, fail, type Order, type Status } from '../state';
import { money } from '../i18n';

const STEPS: Status[] = ['accepted', 'at_pickup', 'picked_up', 'delivered'];

export function Stepper({ status }: { status: Status }) {
  const tr = useT();
  const at = STEPS.indexOf(status);
  return (
    <ol className="steps">
      {STEPS.map((s, i) => (
        <li key={s} className={i < at ? 'is-done' : i === at ? 'is-now' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="steps__dot" />
          <span className="steps__label">{tr(`step_${s}`)}</span>
        </li>
      ))}
    </ol>
  );
}

export function Tracking({ order: o, readOnly }: { order: Order; readOnly?: boolean }) {
  const tr = useT();
  const lang = useApp((s) => s.lang);
  const role = useApp((s) => s.user?.role);
  const [busy, setBusy] = useState(false);
  const live = !['delivered', 'cancelled', 'expired'].includes(o.status);
  const canCancel = !readOnly && ['requested', 'accepted', 'at_pickup'].includes(o.status);

  const share = async () => {
    const url = `${location.origin}/t/${o.code}`;
    try {
      if (navigator.share) await navigator.share({ title: `JBK ${o.code}`, url });
      else { await navigator.clipboard.writeText(url); toast(tr('link_copied'), 'good'); }
    } catch { /* compartilhamento cancelado */ }
  };
  const again = () => {
    patchDraft({ pickup: o.pickup, dropoff: o.dropoff, item: o.item });
    focusOrder(null);
    go('request');
  };

  return (
    <Sheet onClose={!readOnly && (!live || role === 'store') ? () => focusOrder(null) : undefined}>
      <div className={`status status--${o.status}`}>
        {o.status === 'requested' && <span className="seek" aria-hidden="true" />}
        <div>
          <h2 className="status__title">{tr(`st_${o.status}`)}</h2>
          <p className="status__meta">
            {tr('order_code', { code: o.code })} · {money(lang, o.price, o.currency)} · {tr('km', { n: o.distanceKm })}
          </p>
        </div>
      </div>

      {o.status !== 'requested' && o.status !== 'cancelled' && o.status !== 'expired' && <Stepper status={o.status} />}

      {o.courier && live && (
        <div className="who">
          <span className="who__seal who__seal--mine" dangerouslySetInnerHTML={{ __html: icon(o.courier.vehicle, 24) }} />
          <div className="grow">
            <strong>{o.courier.name}</strong>
            <small>{tr(o.courier.vehicle)}{o.courier.plate ? ` · ${o.courier.plate}` : ''}</small>
          </div>
          {o.courier.phone && <a className="btn" href={`tel:${o.courier.phone}`}>{tr('call')}</a>}
        </div>
      )}

      <ul className="legs legs--quiet">
        <li><span className="legs__mark legs__mark--pickup" aria-hidden="true" /><div><small>{tr('pickup')}</small><p>{o.pickup.label}</p></div></li>
        <li><span className="legs__mark legs__mark--dropoff" aria-hidden="true" /><div><small>{tr('dropoff')}</small><p>{o.dropoff.label}</p></div></li>
      </ul>

      <div className="row">
        {live && !readOnly && <button className="btn grow" onClick={share}>{tr('share_link')}</button>}
        {canCancel && (
          <button className="btn btn--danger" disabled={busy}
            onClick={() => { setBusy(true); cancelOrder(o.id).catch(fail).finally(() => setBusy(false)); }}>
            {tr('cancel_order')}
          </button>
        )}
        {!live && !readOnly && (
          <button className="btn btn--primary grow" onClick={o.status === 'delivered' ? () => focusOrder(null) : again}>
            {tr(o.status === 'delivered' ? 'new_order' : 'try_again')}
          </button>
        )}
        {readOnly && !live && <a className="btn btn--primary grow" href="/">{tr('open_app')}</a>}
      </div>
    </Sheet>
  );
}
