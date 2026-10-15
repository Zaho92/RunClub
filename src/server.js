// Der lokale Dienst: die Seite, ihre Schriften und die Schnittstelle unter `/api/`. Er lauscht nur auf 127.0.0.1
// (`listen` macht backend.js) und lässt nur herein, wer den Schlüssel dieses Programmlaufs als Cookie trägt (siehe
// access.js). Ändernde Aufrufe (POST) brauchen dazu das Token aus der Seite: Eine fremde Webseite kann es nicht kennen.
//
//   GET  /api/ping, /fonts/<name>.woff2   ohne Schlüssel
//   GET  /?key=<Schlüssel>                tauscht den Schlüssel gegen das Cookie
//   GET  /                                die Seite (ui.html mit Token und Nonce)
//   GET  /api/status, /api/metrics/day, /api/log, /api/log/file, /api/repos
//   POST /api/<Aufruf>                    ein Aufruf aus actions.js oder von der App (`hooks.actions`)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pageHeaders, newNonce, same } = require('./access');

const BODY_MAX = 10000; // Zeichen; kein Aufruf der Oberfläche braucht mehr
const FONT = /^\/fonts\/([a-z0-9-]+\.woff2)$/;

// Liest das JSON-Objekt einer Anfrage. Wirft mit einer Meldung für die Oberfläche, wenn es keines ist oder zu groß.
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    // Bricht die Verbindung mitten im Aufruf ab, endet das Warten trotzdem.
    request.on('error', reject);
    request.on('close', () => { if (!request.complete) reject(new Error('Der Aufruf kam nicht vollständig an.')); });
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_MAX) { reject(new Error('Der Aufruf ist zu groß.')); request.destroy(); }
    });
    request.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('kein Objekt');
        resolve(data);
      } catch { reject(new Error('Der Aufruf ist kein gültiges JSON-Objekt.')); }
    });
  });
}

//   access                  siehe access.js
//   token                   schützt die ändernden Aufrufe; steht in der Seite
//   uiFile, fontsDir        die Seite (wird bei jedem Laden frisch gelesen) und der Ordner der Schriften
//   routes                  `status()`, `dayMinutes()`, `log()` ({ stamp, entries }), `logFile()` (Text), `repos()` (Promise)
//   actions()               die Aufrufe: Name -> async (Objekt aus der Anfrage)
function createServer({ access, token, uiFile, fontsDir, routes, actions }) {
  const page = (nonce) => fs.readFileSync(uiFile, 'utf8').replace('__TOKEN__', token).replace('__NONCE__', nonce);

  return http.createServer(async (request, response) => {
    const json = (code, data) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)); };
    const get = (url) => request.method === 'GET' && request.url === url;
    // Nur der eigene Rechner unter seinem eigenen Namen: hält umgeleitete Namen fremder Seiten draußen.
    if (!access.hostAllowed(request.headers)) return json(403, { error: 'falscher Host' });
    if (get('/api/ping')) return json(200, { ok: true });
    const font = request.method === 'GET' && request.url.match(FONT);
    if (font && fs.existsSync(path.join(fontsDir, font[1]))) {
      response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable' });
      return response.end(fs.readFileSync(path.join(fontsDir, font[1])));
    }
    // Der Einstieg tauscht den Schlüssel gegen das Cookie; alles Weitere gibt es nur mit Cookie (siehe access.js).
    if (request.method === 'GET' && access.entering(request.url)) {
      response.writeHead(302, { location: '/', 'set-cookie': access.cookie, 'cache-control': 'no-store' });
      return response.end();
    }
    if (!access.allowed(request.headers)) return json(403, { error: 'Kein Zugriff. RunClub über das Symbol im Infobereich öffnen.' });
    if (get('/')) {
      const nonce = newNonce();
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...pageHeaders(nonce) });
      return response.end(page(nonce));
    }
    if (get('/api/status')) return json(200, routes.status());
    if (get('/api/metrics/day')) return json(200, routes.dayMinutes());
    if (get('/api/log')) return json(200, routes.log());
    // Die ganze Datei zum Speichern oder Kopieren.
    if (get('/api/log/file')) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="runclub.log"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return response.end(routes.logFile());
    }
    if (get('/api/repos')) {
      try { return json(200, await routes.repos()); } catch (error) { return json(502, { error: error.message }); }
    }
    if (request.method === 'POST' && request.url.startsWith('/api/')) {
      const name = request.url.slice('/api/'.length);
      const known = actions();
      const action = Object.hasOwn(known, name) ? known[name] : null;
      if (!action) return json(404, { error: 'unbekannt' });
      if (!same(request.headers['x-rc-token'], token)) return json(403, { error: 'Die Seite ist veraltet – bitte neu laden.' });
      try { await action(await readBody(request)); return json(200, { ok: true }); } catch (error) { return json(400, { error: error.message }); }
    }
    return json(404, { error: 'unbekannt' });
  });
}

// Führt die Aufrufe aus actions.js und die der App zusammen. Derselbe Name an zwei Stellen ist ein Fehler: Einer der
// beiden würde sonst still verdeckt.
function mergeActions(...sets) {
  const merged = {};
  for (const set of sets) {
    for (const [name, action] of Object.entries(set)) {
      if (Object.hasOwn(merged, name)) throw new Error(`Den Aufruf ${name} gibt es doppelt.`);
      merged[name] = action;
    }
  }
  return merged;
}

module.exports = { createServer, mergeActions, readBody, BODY_MAX };
