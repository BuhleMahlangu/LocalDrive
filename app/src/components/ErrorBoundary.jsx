import React from 'react';

// Catches render errors in the tree below it so a single bad screen (or a
// transient data shape change) can't blank the whole app. Reset it by changing
// `resetKey`, or via the "Go back" button.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && this.props.resetKey !== prevProps.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) return this.props.children;

    const friendly = {
      error: this.state.error,
      detail: this.state.error.message || String(this.state.error),
    };

    return (
      <div className="screen" style={{ maxWidth: '520px', margin: '0 auto', padding: '24px 16px 48px' }}>
        <div className="card">
          <div style={{ fontSize: '34px', marginBottom: '8px' }} aria-hidden="true">😖</div>
          <h2>Something went wrong on this screen</h2>
          <p className="hint" style={{ margin: '6px 0 0' }}>
            The rest of the app is fine — this screen hit an unexpected error. Tap
            button below to reload it. If it keeps happening, tell your driver.
          </p>
          <p className="error" style={{ fontSize: '12px', wordBreak: 'break-word' }}>
            {friendly.detail}
          </p>
          <div className="btn-row" style={{ marginTop: '14px' }}>
            <button
              className="btn primary"
              onClick={() => {
                if (typeof this.props.onReset === 'function') this.props.onReset();
                this.setState({ error: null });
              }}
            >
              Reload this screen
            </button>
            <button
              className="btn"
              onClick={() => window.location.reload()}
            >
              Reload the app
            </button>
          </div>
        </div>
      </div>
    );
  }
}