// Single-owner password login. Stateless signed cookie, 30-day sliding expiry.
import crypto from 'node:crypto';
import { load, save } from './store.js';

const DAYS = 30, TTL = DAYS * 864e5, COOKIE = 'dh_session';
let secret = process.env.SESSION_SECRET || load('secret.json', null)?.s;
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); save('secret.json', { s: secret }); }

const hash = process.env.ADMIN_PASSWORD_HASH || '';           // scrypt:<saltHex>:<hashHex>
export const configured = () => hash.startsWith('scrypt:');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw) {
  const [, salt, h] = hash.split(':'); if (!salt || !h) return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64), want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const sign = (exp) => crypto.createHmac('sha256', secret).update(String(exp)).digest('hex');
const mk = (now) => { const exp = now + TTL; return `${exp}.${sign(exp)}`; };

const cookieOf = (req, name) => (req.headers.cookie || '').split(/;\s*/).map((c) => c.split('=')).find(([k]) => k === name)?.[1];

// Returns true if request carries a valid session. Renews cookie (sliding) via setCookie callback.
export function check(req, setCookie, now = Date.now()) {
  const v = cookieOf(req, COOKIE); if (!v) return false;
  const [exp, sig] = v.split('.');
  const want = sign(exp);
  if (!sig || sig.length !== want.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return false;
  if (Number(exp) < now) return false;
  if (Number(exp) - now < TTL - 864e5) setCookie(mk(now));   // renew at most once a day
  return true;
}

// Global failed-login limiter (can't trust per-IP headers through proxies). Owner keeps working via cookie.
let fails = [];
export function login(pw, now = Date.now()) {
  fails = fails.filter((t) => now - t < 15 * 60_000);
  if (!configured()) return { ok: false, status: 403, error: 'No admin password configured' };
  if (fails.length >= 8) return { ok: false, status: 429, error: 'Too many attempts, try again later' };
  if (typeof pw !== 'string' || !verifyPassword(pw)) { fails.push(now); return { ok: false, status: 401, error: 'Wrong password' }; }
  return { ok: true, token: mk(now) };
}

export const cookieHeader = (token, secure, clear = false) =>
  `${COOKIE}=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : TTL / 1000}${secure ? '; Secure' : ''}`;
