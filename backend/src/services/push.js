const config = require('../config');
const repo = require('../db/repository');

function webPush() {
  if (!config.webPush.publicKey || !config.webPush.privateKey) return null;
  const webPush = require('web-push');
  webPush.setVapidDetails(config.webPush.subject, config.webPush.publicKey, config.webPush.privateKey);
  return webPush;
}

async function sendToUser(userId, payload) {
  const client = webPush();
  if (!client) return { skipped: true, reason: 'vapid-not-configured' };
  const subs = repo.getPushSubscriptions(userId);
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const results = [];
  for (const sub of subs) {
    try {
      await client.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth },
      }, body);
      results.push({ ok: true });
    } catch (e) {
      // 404/410 mean the subscription is dead.
      if (e.statusCode === 404 || e.statusCode === 410) {
        repo.removePushSubscription(sub.endpoint);
      }
      results.push({ ok: false, error: e.message });
    }
  }
  return { skipped: false, results };
}

module.exports = { sendToUser, webPush };
