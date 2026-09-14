import React, { useEffect, useState } from 'react';
import { api, apiUpload, validateSaId } from '../../api.js';
import ThemeToggle from '../../components/ThemeToggle.jsx';
import Icon from '../../components/Icon.jsx';

// Driver onboarding: collect the vetting documents (SA ID number + copies) and
// show the application status until the admin approves the driver.
export default function Apply({ user, onUserUpdate, onLogout, onSwitchRole }) {
  const [status, setStatus] = useState('loading'); // loading | pending | rejected | form
  const [application, setApplication] = useState(null);
  const [idNumber, setIdNumber] = useState('');
  const [idCopy, setIdCopy] = useState(null);
  const [selfie, setSelfie] = useState(null);
  const [proof, setProof] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showForm, setShowForm] = useState(false);

  useEffect(() => {
    api('/driver/application')
      .then((r) => {
        setApplication(r.application);
        setIdNumber(r.application?.idNumber || '');
        if (r.driverStatus === 'pending') setStatus('pending');
        else if (r.driverStatus === 'rejected') setStatus('rejected');
        else setStatus('form');
      })
      .catch(() => setStatus('form'));
  }, []);

  function onFile(setter) {
    return (e) => {
      const f = e.target.files && e.target.files[0];
      if (f) setter(f);
    };
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setMessage('');
    if (!validateSaId(idNumber)) {
      setError('Please enter a valid 13-digit SA ID number (e.g. 9001015800088).');
      return;
    }
    if (!idCopy && !selfie && !proof) {
      setError('Upload at least one document (ID copy, selfie or proof of residence).');
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('idNumber', idNumber.trim());
      if (idCopy) fd.append('idCopy', idCopy);
      if (selfie) fd.append('selfie', selfie);
      if (proof) fd.append('proofOfResidence', proof);
      const res = await apiUpload('/driver/register', fd);
      setApplication(res.application);
      if (res.user) onUserUpdate(res.user);
      setStatus('pending');
      setMessage('Application submitted — you will be notified once it is reviewed.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app driver-app driver-apply">
      <header className="dash-header">
        <span className="brand brand-logomark"><img src="/logo-horizontal.png" alt="DriveLocal" /><em>Driver</em></span>
        <span className="user-chip">{user.name || user.phone}</span>
        <button className="chip-btn" onClick={() => onSwitchRole('customer')} title="Switch to the customer app">
          <Icon name="swap" size={14} /> Customer mode
        </button>
        <ThemeToggle />
        <button className="link-btn" onClick={onLogout}>Log out</button>
      </header>

      <div className="screen">
        {status === 'loading' && <p className="hint">Loading…</p>}

        {status === 'pending' && (
          <div className="card">
            <h2>Application under review</h2>
            <p className="hint">
              Thanks! Your driver application has been submitted. The platform owner
              will review your documents and approve you to start taking rides.
            </p>
            {application?.submittedAt && (
              <p className="hint">Submitted on {new Date(application.submittedAt).toLocaleString?.('en-ZA')}</p>
            )}
          </div>
        )}

        {status === 'rejected' && (
          <div className="card">
            <h2>Application not approved</h2>
            {user.rejectionReason && (
              <p className="error" style={{ margin: '8px 0' }}>Reason: {user.rejectionReason}</p>
            )}
            <p className="hint">
              Fix whatever was the problem (e.g. upload a clearer copy of your ID or proof
              of residence) and re-submit.
            </p>
            <div className="btn-row">
              <button className="btn driver" onClick={() => setShowForm(true)}>Edit and re-submit</button>
            </div>
          </div>
        )}

        {(status === 'form' || (status === 'rejected' && showForm)) && (
          <>
            <h1>Become a driver</h1>
            <p className="subtitle">We verify every driver so customers feel safe. Submit the documents below — you'll be approved by the owner before you can take rides.</p>

            <form className="card form-card" onSubmit={submit}>
              <div className="field">
                <span className="field-label">SA ID number</span>
                <input
                  type="text" inputMode="numeric"
                  value={idNumber}
                  onChange={(e) => setIdNumber(e.target.value)}
                  placeholder="e.g. 9001015800082"
                  required
                />
              </div>

              <div className="field">
                <span className="field-label">Copy of ID</span>
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={onFile(setIdCopy)} />
              </div>

              <div className="field">
                <span className="field-label">Your photo</span>
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={onFile(setSelfie)} />
                <p className="hint">A clear picture of your face.</p>
              </div>

              <div className="field">
                <span className="field-label">Proof of residence</span>
                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={onFile(setProof)} />
                <p className="hint">A recent utility bill, affidavit or bank statement.</p>
              </div>

              {message && <p className="success">{message}</p>}
              {error && <p className="error">{error}</p>}

              <div className="btn-row" style={{ marginTop: '6px' }}>
                <button className="btn driver big" disabled={busy}>{busy ? 'Submitting…' : 'Submit application'}</button>
              </div>
            </form>

            <div className="card">
              <h3>What happens next?</h3>
              <p className="hint" style={{ margin: '6px 0 0' }}>
                1. We review your ID and proof of residence. 2. Once approved you'll
                go online from the driver home. 3. You keep 90% of every fare, the
                platform keeps a 10% commission.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}