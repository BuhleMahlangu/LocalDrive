import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.jsx';

// Small first-run walkthrough shown as a dismissible overlay. It introduces the
// three steps that new customers miss most: set a pin, describe the spot, and
// pick how to pay. Auto-dismisses after a few seconds; stores "seen" in
// localStorage so it shows at most once.

const SEEN_KEY = 'drivelocal_onboarded';

export function hasSeenOnboarding() {
  try { return localStorage.getItem(SEEN_KEY) === '1'; } catch { return true; }
}

export function markOnboardingSeen() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch { /* ignore */ }
}

export default function Onboarding({ onDone }) {
  const { t } = useI18n();
  const [step, setStep] = useState(0);
  const [show, setShow] = useState(false);
  const lastHitRef = useRef(Date.now());

  useEffect(() => {
    // Delay appearance slightly so the screen paints first.
    const timer = setTimeout(() => setShow(true), 600);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!show) return;
    // Auto-advance through the steps; finish when the last one is reached.
    if (Date.now() - lastHitRef.current < 100) return;
    const timer = setTimeout(() => {
      if (step >= 2) {
        finish();
      } else {
        setStep(step + 1);
      }
    }, 3500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, show]);

  function finish() {
    markOnboardingSeen();
    setShow(false);
    if (onDone) onDone();
  }

  if (!show) return null;

  const steps = [
    {
      icon: '📍',
      title: 'Drop a pin',
      body: 'Tap the map to set your pickup and destination — no street names needed.',
    },
    {
      icon: '💬',
      title: 'Describe the spot',
      body: '“Opposite the red shop” or “next to the big tree” helps the driver find you exactly.',
    },
    {
      icon: '💵',
      title: 'Pick how to pay',
      body: 'Cash or card, right in the app. Track the driver live on your map.',
    },
  ];

  const s = steps[step];

  return (
    <div className="modal-overlay onboard-overlay" role="dialog" aria-modal="true" aria-label="Getting started">
      <div className="modal-card onboard-card">
        <div className="onboard-head">
          <span className="onboard-icon" aria-hidden="true">{s.icon}</span>
          <h2>{s.title}</h2>
        </div>
        <p className="hint">{s.body}</p>
        <div className="onboard-dots" aria-hidden="true">
          {steps.map((_, i) => (
            <span key={i} className={`onboard-dot ${i === step ? 'on' : ''}`} />
          ))}
        </div>
        <div className="btn-row onboard-actions">
          <button className="btn" onClick={finish}>{t('common.skip')}</button>
          <button className="btn primary" onClick={() => step >= 2 ? finish() : setStep(step + 1)}>
            {step >= 2 ? t('common.done') : t('common.next')}
          </button>
        </div>
      </div>
    </div>
  );
}