import React, { useEffect, useState } from 'react';
import { api, formatRand } from '../../api.js';
import Icon from '../../components/Icon.jsx';
import EmptyState from '../../components/EmptyState.jsx';
import Skeleton from '../../components/Skeleton.jsx';
import { useI18n } from '../../i18n.jsx';

// Driver subscription (freemium model). The platform earns from a monthly
// driver subscription instead of a per-ride cut — so a driver's own plan status
// matters: while it is active they can go online and take rides; once it lapses
// they can still sign in, see this screen and renew, but receive no bookings.
//
// The owner account is 'free' forever, so this screen just confirms that.
export default function Subscription() {
  const { t } = useI18n();
  const [sub, setSub] = useState(null);
  const [payments, setPayments] = useState([]);
  const [error, setError] = useState('');
  // "Now" is captured once per data load rather than during render (React must
  // stay pure), so the days-left figure is stable between renders.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    api('/driver/subscription')
      .then((r) => {
        if (!live) return;
        setSub(r.subscription || null);
        setPayments(Array.isArray(r.payments) ? r.payments : []);
        setNow(Date.now());
      })
      .catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);

  if (!sub) {
    return (
      <div className="screen">
        <h1>{t('sub.title')}</h1>
        {error ? <p className="error">{error}</p> : <Skeleton card lines={3} />}
      </div>
    );
  }

  const periodEnd = sub.periodEnd ? new Date(sub.periodEnd) : null;
  const daysLeft = periodEnd ? Math.ceil((periodEnd.getTime() - now) / 86_400_000) : null;
  const isFree = sub.plan === 'free';
  const isActive = sub.active;

  return (
    <div className="screen">
      <h1>{t('sub.title')}</h1>
      {error && <p className="error">{error}</p>}

      <div className="card">
        <div className="field-row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <strong>{isFree ? t('sub.freePlan') : sub.plan === 'active' ? t('sub.activePlan') : t('sub.noPlan')}</strong>
            <p className="hint" style={{ margin: '2px 0 0' }}>
              {isFree
                ? t('sub.freeHint')
                : periodEnd
                  ? t('sub.renewsOn', { date: periodEnd.toLocaleDateString() })
                  : t('sub.noPeriod')}
            </p>
          </div>
          <span className={`badge ${isActive ? 'completed' : 'cancelled'}`}>
            {isActive ? t('sub.statusActive') : t('sub.statusInactive')}
          </span>
        </div>

        {!isFree && (
          <div className="stats-grid" style={{ marginTop: '12px' }}>
            <div className="stat-tile">
              <span className="stat-num">{formatRand((sub.priceCents || 0) / 100)}</span>
              <span className="stat-label">{t('sub.price')}</span>
            </div>
            {daysLeft != null && (
              <div className="stat-tile">
                <span className="stat-num">{daysLeft > 0 ? daysLeft : 0}</span>
                <span className="stat-label">{t('sub.daysLeft')}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {!isActive && !isFree && (
        <div className="card" style={{ background: 'var(--danger-soft)', border: '1px solid var(--danger)' }}>
          <p style={{ margin: 0 }}>
            <Icon name="receipt" size={16} /> {t('sub.inactiveNotice')}
          </p>
        </div>
      )}

      {isFree && (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}><Icon name="receipt" size={16} /> {t('sub.ownerNote')}</p>
        </div>
      )}

      <h2>{t('sub.payments')}</h2>
      {payments.length === 0 ? (
        <EmptyState title={t('sub.noPayments')} message={t('sub.noPaymentsHint')} />
      ) : (
        payments.map((p) => (
          <div className="card" key={p.id}>
            <div className="field-row" style={{ justifyContent: 'space-between' }}>
              <strong>{formatRand((p.amountCents || 0) / 100)}</strong>
              <span className="hint">{new Date(p.createdAt).toLocaleDateString()}</span>
            </div>
            <p className="hint" style={{ margin: '4px 0 0' }}>
              {t('sub.months', { n: p.months })}
              {p.method ? ` · ${p.method}` : ''}
              {p.reference ? ` · ${p.reference}` : ''}
            </p>
          </div>
        ))
      )}
    </div>
  );
}
