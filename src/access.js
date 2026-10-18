// Who may use the local service.
//
// The service listens on 127.0.0.1, but under Docker Desktop it can also be reached from the jobs' containers
// (host.docker.internal). So the address is not enough: page and data are only given to whoever knows the key of this
// program run. The app window opens the entry address with the key and gets a cookie for it; a job does not know
// the key.

const crypto = require('node:crypto');

const COOKIE = 'rc';

// The page loads nothing from outside and cannot be embedded in other pages. Scripts only run with the
// id of this one response (`nonce`): if a name from GitHub ever got into the HTML unescaped, it would
// still not be executed. Styles may be inline because the page sets its sizes as `style` attributes.
const pageHeaders = (nonce) => ({
  'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});
const newNonce = () => crypto.randomBytes(16).toString('base64');

// Compares two secrets without the duration revealing how far they match.
function same(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieOf(header) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE) return part.slice(at + 1).trim();
  }
  return null;
}

function createAccess({ port, key = crypto.randomBytes(24).toString('hex') }) {
  const hosts = [`localhost:${port}`, `127.0.0.1:${port}`];
  return {
    key,
    // This address trades the key for the cookie and leads to the page. It names the address the service listens on:
    // `localhost` could also go over IPv6 (`::1`), where another program would accept the key.
    entry: `http://127.0.0.1:${port}/?key=${key}`,
    cookie: `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`,
    // Only this machine under its own name: keeps out other sites' host names pointed here (DNS rebinding).
    hostAllowed: (headers) => hosts.includes(headers.host ?? ''),
    allowed: (headers) => same(cookieOf(headers.cookie), key),
    // Is this the entry address with the right key? `null` if the address is not an entry address.
    entering(url) {
      const match = String(url ?? '').match(/^\/\?key=([^&#]*)$/);
      return match ? same(match[1], key) : null;
    },
  };
}

module.exports = { createAccess, pageHeaders, newNonce, same };
