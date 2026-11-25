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

/**
 * Why a request must be turned away before it reaches a route, or null.
 *
 * Binding to localhost was mistaken for a boundary. It is not one: the
 * browser the operator is already using can reach 127.0.0.1 perfectly well,
 * and it attaches whatever credentials it has cached. Any page they visit
 * could post a form here and flip the upload switches on their real channel.
 * So the three checks below are what actually separates "the operator asked
 * for this" from "a web page asked for this on their behalf".
 */

/** Addresses that only this machine can reach. */
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '']);

/** Methods that only read. Everything else can change something. */
const READ_ONLY = new Set(['GET', 'HEAD', 'OPTIONS']);

const hostOnly = (value) => {
  const host = String(value ?? '').trim().toLowerCase();
  // [::1]:3000 -> ::1, and 127.0.0.1:3000 -> 127.0.0.1
  const bracketed = host.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1];
  return host.split(':')[0];
};

/**
 * Is the Host header one this server is willing to answer to?
 *
 * Without this, a domain whose DNS record flips to 127.0.0.1 a second after
 * the page loads becomes same-origin with the dashboard, and its JavaScript
 * can read the stats, the channel list and the rendered shorts. The socket is
 * still local; the attacker simply had the browser walk through the door.
 */
export function hostAllowed(headerHost, { host, extra = [] }) {
  const asked = hostOnly(headerHost);
  if (!asked) return false;
  // Whatever the server was told to bind to is, by definition, a name it may
  // be reached by - including an operator who deliberately opened it.
  if (asked === hostOnly(host)) return true;
  // A tunnel or reverse proxy arrives with its own name in the Host header,
  // which is the entire point of one. Rejecting those outright would have
  // broken every working remote setup in the name of a threat the password
  // already covers, so the operator can name the ones they meant.
  if (extra.some((name) => hostOnly(name) === asked)) return true;
  return LOCAL.has(asked);
}

/**
 * Did this request come from the dashboard itself, rather than another site?
 *
 * Sec-Fetch-Site is sent by every current browser and cannot be set by page
 * script, so it is the primary check. Origin is the fallback for older ones.
 * A request carrying neither is not coming from a browser at all - curl, a
 * script, a test - and those are not the thing being defended against, since
 * an attacker who can run commands on this machine has already won.
 */
export function sameOrigin(req, { host, port }) {
  if (READ_ONLY.has(String(req.method || 'GET').toUpperCase())) return true;

  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site) return site === 'same-origin' || site === 'none';

  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      return false;
    }
    return hostAllowed(parsed.host, { host, port }) && parsed.port === String(port);
  }

  return true;
}

/**
 * Is the body claiming to be JSON?
 *
 * A cross-site form can only send three content types, and application/json
 * is not one of them: asking for it forces anything scripted into a preflight
 * this server never answers. It also closes the specific trick of smuggling
 * JSON through a text/plain form, where the name=value pair is arranged to
 * spell an object.
 */
export function isJsonBody(contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

export const isLocalHost = (host) => LOCAL.has(String(host ?? '').trim());

/**
 * Why this configuration must not start, or null if it may.
 *
 * Binding to the network without a password does not merely show strangers a
 * page: the dashboard flips the upload switches, edits the channel list and
 * spends the quota on accounts the owner connected. A warning would scroll
 * away and leave the port open, so this refuses instead.
 */
export function refuseOpenDashboard({ host, password, extra = [] }) {
  if (password) return null;
  if (!isLocalHost(host)) {
    return `HOST is set to ${host}, which lets other machines reach this dashboard. ` +
      'Set DASHBOARD_PASSWORD in .env as well, or leave HOST unset to stay on this machine only.';
  }
  // Naming a tunnel is saying out loud that strangers can reach this. The
  // socket being on localhost is no comfort when something else is carrying
  // the internet to it.
  if (extra.length) {
    return `DASHBOARD_HOSTS names ${extra.join(', ')}, which means something outside this machine ` +
      'reaches the dashboard. Set DASHBOARD_PASSWORD in .env as well, or remove DASHBOARD_HOSTS.';
  }
  return null;
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
