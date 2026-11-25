// Who may see the dashboard.
//
// On localhost the address was the privacy: nobody else could reach it. Behind
// a tunnel that stops being true, because the URL is not a secret and the page
// can change the streamer list, flip the upload switches and spend quota.
//
// So: a password, and nothing changes until one is set. A run with no
// DASHBOARD_PASSWORD behaves exactly as it did before.

import { createHash, timingSafeEqual } from 'node:crypto';

// TikTok re-checks the Terms and Privacy links, and its own signature file,
// from its own servers. Those have no password and never will, so these three
// stay open. Everything else is the owner's.
const OPEN = new Set(['/terms', '/privacy']);
const SIGNATURE = /^\/tiktok[A-Za-z0-9]+\.txt$/;

export const isPublicPath = (pathname) => OPEN.has(pathname) || SIGNATURE.test(pathname);

// Compared as digests so the check takes the same time whatever is sent, and
// so a wrong guess does not reveal the length of the right answer.
const digest = (value) => createHash('sha256').update(String(value), 'utf8').digest();
const sameSecret = (a, b) => timingSafeEqual(digest(a), digest(b));

/** Addresses that only this machine can reach. */
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '']);

export const isLocalHost = (host) => LOCAL.has(String(host ?? '').trim());

/**
 * Why this configuration must not start, or null if it may.
 *
 * Binding to the network without a password does not merely show strangers a
 * page: the dashboard flips the upload switches, edits the channel list and
 * spends the quota on accounts the owner connected. A warning would scroll
 * away and leave the port open, so this refuses instead.
 */
export function refuseOpenDashboard({ host, password }) {
  if (isLocalHost(host)) return null;
  if (password) return null;
  return `HOST is set to ${host}, which lets other machines reach this dashboard. ` +
    'Set DASHBOARD_PASSWORD in .env as well, or leave HOST unset to stay on this machine only.';
}

/**
 * Basic auth, username ignored: there is one owner, and asking them to invent
 * a username as well would only be a second thing to forget.
 */
export function authorized(header, password) {
  if (!password) return true;
  if (typeof header !== 'string') return false;
  const [scheme, encoded] = header.split(' ');
  if (!encoded || scheme.toLowerCase() !== 'basic') return false;
  let decoded = '';
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  if (colon < 0) return false;
  return sameSecret(decoded.slice(colon + 1), password);
}
