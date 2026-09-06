import { api, getToken } from './api';

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && Notification && Notification.permission;
}

async function getVapidKey() {
  try {
    const { publicKey } = await api('/push/vapid');
    return publicKey;
  } catch {
    return null;
  }
}

export async function registerPush(force = false) {
  try {
    if (!pushSupported()) return { ok: false, reason: 'unsupported' };
    const publicKey = await getVapidKey();
    if (!publicKey) return { ok: false, reason: 'vapid-not-configured' };

    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;

    if (Notification.permission === 'denied') return { ok: false, reason: 'denied' };

    // If we already have a subscription on this device, reuse it if present.
    const existing = await reg.pushManager.getSubscription();
    let subscription = existing;
    if (!subscription) {
      // Only prompt the user for permission when explicitly requested.
      if (Notification.permission === 'default' && !force) {
        return { ok: false, reason: 'not-opted-in' };
      }
      if (Notification.permission === 'default') {
        const granted = await Notification.requestPermission();
        if (granted !== 'granted') return { ok: false, reason: 'denied' };
      }
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    await api('/push/subscribe', {
      method: 'POST',
      body: {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('p256dh')))),
          auth: btoa(String.fromCharCode(...new Uint8Array(subscription.getKey('auth')))),
        },
      },
      token: getToken(),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function unregisterPush() {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js');
    const sub = reg && (await reg.pushManager.getSubscription());
    if (sub) {
      await api('/push/unsubscribe', {
        method: 'POST',
        body: { endpoint: sub.endpoint },
        token: getToken(),
      });
      await sub.unsubscribe();
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}
