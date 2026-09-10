import React from 'react';

const ICONS = {
  home: (
    <>
      <path d="M4 11.25 12 4.5l8 6.75" />
      <path d="M6 10.5v9h12v-9" />
    </>
  ),
  book: (
    <>
      <circle cx="6.5" cy="17.5" r="2" />
      <circle cx="17.5" cy="6.5" r="2" />
      <path d="M8.4 16.1 15.6 8.9" />
    </>
  ),
  car: (
    <>
      <path d="M6.4 16l1.8-6.6A2 2 0 0 1 10.1 8h3.8a2 2 0 0 1 1.9 1.4L17.6 16" />
      <path d="M4.5 16h15v1.5a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1-.75-.75V16.5" />
      <circle cx="7.5" cy="18.25" r="1.25" />
      <circle cx="16.5" cy="18.25" r="1.25" />
    </>
  ),
  history: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.2l2.8 1.7" />
    </>
  ),
  trips: (
    <>
      <path d="M5 20h14" />
      <path d="M7 20v-6" />
      <path d="M12 20V8" />
      <path d="M17 20v-10" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5.5 20c.9-3.2 3.5-5 6.5-5s5.6 1.8 6.5 5" />
    </>
  ),
  logout: (
    <>
      <path d="M14 4H6v16h8" />
      <path d="M10 12h9.5m0 0-3-3m3 3-3 3" />
    </>
  ),
  swap: (
    <>
      <path d="M4 7h13m0 0-3-3m3 3-3 3" />
      <path d="M20 17H7m0 0 3-3m-3 3 3 3" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </>
  ),
  moon: <path d="M20 13.5A8 8 0 0 1 10.5 4 7.5 7.5 0 1 0 20 13.5Z" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
    </>
  ),
};

export default function Icon({ name, size = 20, className = '', strokeWidth = 1.8 }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}