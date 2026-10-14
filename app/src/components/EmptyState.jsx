import React from 'react';

// Consistent empty-state block used when a list or view has no data yet.
export default function EmptyState({ icon = "Empty", title, message, actionLabel, onAction }) {
  return (
    <div className="empty-state" role="status">
      <div className="empty-state-icon" aria-hidden="true">{icon}</div>
      {title ? <h3 className="empty-state-title">{title}</h3> : null}
      {message ? <p className="hint empty-state-message">{message}</p> : null}
      {actionLabel && onAction ? (
        <button type="button" className="btn small primary" onClick={onAction}>{actionLabel}</button>
      ) : null}
    </div>
  );
}