const nodemailer = require('nodemailer');
const config = require('../config');

let transporter = null;

function isConfigured() {
  return !!(config.smtp && config.smtp.host && config.smtp.user && config.smtp.pass);
}

function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: { user: config.smtp.user, pass: config.smtp.pass },
    });
  }
  return transporter;
}

async function verify() {
  const t = getTransporter();
  if (!t) return false;
  try {
    await t.verify();
    return true;
  } catch (e) {
    console.warn('[email] SMTP verification failed:', e.message);
    return false;
  }
}

async function send({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t || !to) {
    // No provider configured (or no recipient): fall back to console so dev
    // and test flows keep working without real infrastructure.
    console.log(`[email] (no provider configured) To ${to || '?'}: ${subject}\n${text}`);
    return { queued: false, dev: true };
  }
  const info = await t.sendMail({
    from: config.smtp.from,
    to,
    replyTo: config.smtp.replyTo,
    subject,
    text,
    html,
  });
  return { queued: true, messageId: info.messageId };
}

module.exports = { isConfigured, verify, send };