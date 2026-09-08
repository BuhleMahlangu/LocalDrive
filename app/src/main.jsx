import React from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.jsx';
import { applyTheme } from './api.js';
import './styles.css';

registerSW({ immediate: true });
applyTheme();

createRoot(document.getElementById('root')).render(
  <App />,
);
