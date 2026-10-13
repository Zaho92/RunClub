// Wer den lokalen Dienst benutzen darf.
//
// Der Dienst lauscht auf 127.0.0.1, ist unter Docker Desktop aber auch aus den Containern der Jobs erreichbar
// (host.docker.internal). Deshalb genügt die Adresse nicht: Seite und Daten bekommt nur, wer den Schlüssel dieses
// Programmlaufs kennt. Das Fenster der App öffnet die Einstiegsadresse mit dem Schlüssel und erhält dafür ein
// Cookie; ein Job kennt den Schlüssel nicht.

const crypto = require('node:crypto');

const COOKIE = 'rc';

// Die Seite lädt nichts von außen und lässt sich nicht in fremde Seiten einbetten.
const PAGE_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

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
    // Diese Adresse tauscht den Schlüssel gegen das Cookie und führt zur Seite.
    entry: `http://localhost:${port}/?key=${key}`,
    cookie: `${COOKIE}=${key}; HttpOnly; SameSite=Strict; Path=/`,
    // Nur der eigene Rechner unter seinem eigenen Namen: hält umgeleitete Namen fremder Seiten draußen.
    hostAllowed: (headers) => hosts.includes(headers.host ?? ''),
    allowed: (headers) => same(cookieOf(headers.cookie), key),
    // Ist das die Einstiegsadresse mit dem richtigen Schlüssel? `null`, wenn die Adresse keine Einstiegsadresse ist.
    entering(url) {
      const match = String(url ?? '').match(/^\/\?key=([^&#]*)$/);
      return match ? same(match[1], key) : null;
    },
  };
}

module.exports = { createAccess, PAGE_HEADERS, COOKIE };
