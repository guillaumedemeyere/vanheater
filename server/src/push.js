import webpush from 'web-push';
import { load, save } from './store.js';

let vapid = load('vapid.json', null);
if (!vapid) { vapid = webpush.generateVAPIDKeys(); save('vapid.json', vapid); }
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://example.com', vapid.publicKey, vapid.privateKey);

let subs = load('subs.json', []);
const MAX_SUBS = 25;

export const publicKey = () => vapid.publicKey;
export const subCount = () => subs.length;
export const ntfyEnabled = () => !!process.env.NTFY_URL;

export function addSub(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://') ||
      !sub.keys || typeof sub.keys.p256dh !== 'string' || typeof sub.keys.auth !== 'string') throw new Error('invalid subscription');
  subs = subs.filter((s) => s.endpoint !== sub.endpoint);
  if (subs.length >= MAX_SUBS) throw new Error('too many subscriptions');
  subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: Date.now() });
  save('subs.json', subs);
}
export function removeSub(endpoint) {
  subs = subs.filter((s) => s.endpoint !== endpoint); save('subs.json', subs);
}

export async function sendAll({ title, body, kind = 'alarm', rule = '' }) {
  const payload = JSON.stringify({ title, body, kind, rule, ts: Date.now() });
  const results = await Promise.allSettled(subs.map((s) =>
    webpush.sendNotification(s, payload, { TTL: 3600, urgency: kind === 'alarm' ? 'high' : 'normal' })
      .catch((e) => { if (e.statusCode === 404 || e.statusCode === 410) removeSub(s.endpoint); throw e; })));
  if (ntfyEnabled()) {
    try {
      await fetch(process.env.NTFY_URL, {
        method: 'POST', body,
        headers: { Title: title.replace(/[^\x20-\x7e]/g, ''), Priority: kind === 'alarm' ? 'urgent' : 'default', Tags: kind === 'alarm' ? 'rotating_light,dog' : 'white_check_mark' },
      });
    } catch (e) { console.error('ntfy failed', e.message); }
  }
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed) console.warn(`push: ${failed}/${results.length} failed`);
  return { sent: results.length - failed, failed };
}
