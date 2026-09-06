import React from 'react';

export default function Landing({ onChoose }) {
  return (
    <div className="login-screen landing-screen">
      <div className="brand-hero">
        <div className="brand-badge">DL</div>
        <h1>DriveLocal</h1>
        <p>Your trusted local driver — book or drive in seconds.</p>
      </div>

      <div className="card landing-card">
        <button type="button" className="btn primary big" onClick={() => onChoose('customer')}>
          🚕 Book a ride
        </button>
        <p className="hint">I'm a customer — request a trip in Thubelihle / Kriel.</p>

        <div className="landing-divider">or</div>

        <button type="button" className="btn driver big" onClick={() => onChoose('driver')}>
          🚗 I'm the driver
        </button>
        <p className="hint">Driver login — accept requests and manage trips.</p>
      </div>
    </div>
  );
}