import React from 'react';

// Shimmer skeleton blocks for loading states.
// - default: a standalone block of lines
// - card: reserves a full card-sized space (for Home/Dashboard cards)
// - avatar: adds a circular image slot beside the text lines
export default function Skeleton({ card = false, avatar = false, lines = 2, style, className = '' }) {
  const bars = [];
  if (avatar) bars.push(<div key="avatar" className="skeleton avatar" />);
  bars.push(
    <div key="stack" className="skeleton-stack">
      <div className="skeleton line-md" />
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className={`skeleton ${i === lines - 1 ? 'line-sm' : 'line-lg'}`} />
      ))}
    </div>,
  );
  const cls = card ? 'skeleton-card-space' : 'skeleton-bar-space';
  const row = avatar ? 'skeleton-line-row' : '';
  return (
    <div className={`${row} ${cls} ${className}`} style={style} aria-hidden="true">
      {bars}
    </div>
  );
}