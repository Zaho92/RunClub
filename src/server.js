// The local service: the page, its fonts and the API under `/api/`. It listens only on 127.0.0.1
// (`listen` is done by backend.js) and lets in only whoever carries this program run's key as a cookie (see
// access.js). Changing calls (POST) also need the token from the page: a foreign web page can't know it.
//
//   GET  /api/ping, /fonts/<name>.woff2   without key
//   GET  /?key=<key>                      swaps the key for the cookie
//   GET  /                                the page (ui.html with token and nonce)
//   GET  /api/status, /api/metrics/day, /api/log, /api/log/file, /api/repos
//   POST /api/<call>                      a call from actions.js or from the app (`hooks.actions`)

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pageHeaders, newNonce, same } = require('./access');
const { msg, isMsg, render, Fault, reason } = require('./messages');

const BODY_MAX = 10000; // characters; no call from the interface needs more
const FONT = /^\/fonts\/([a-z0-9-]+\.woff2)$/;
// An answer with an error: the English sentence in `error`, plus the message as a key (`msg`, see messages.js),
// so that the interface shows it in its own language. A text from outside comes without `msg`.
const failure = (message) => (isMsg(message) ? { error: render(message), msg: message } : { error: String(message) });

// Reads the JSON object of a request. Throws with a message for the interface if it isn't one or is too large.
function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    // If the connection breaks off mid-call, the waiting ends anyway.
    request.on('error', reject);
    request.on('close', () => { if (!request.complete) reject(new Fault('m_bodyIncomplete')); });
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > BODY_MAX) { reject(new Fault('m_bodyTooLarge')); request.destroy(); }
    });
    request.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not an object');
        resolve(data);
      } catch { reject(new Fault('m_bodyNotJson')); }
    });
  });
}

//   access                  see access.js
//   token                   protects the changing calls; is in the page
//   uiFile, fontsDir        the page (read fresh on every load) and the fonts folder
//   routes                  `status()`, `dayMinutes()`, `log()` ({ stamp, entries }), `logFile()` (text), `repos()` (promise)
//   actions()               the calls: name -> async (object from the request)
function createServer({ access, token, uiFile, fontsDir, routes, actions }) {
  const page = (nonce) => fs.readFileSync(uiFile, 'utf8').replace('__TOKEN__', token).replace('__NONCE__', nonce);

  return http.createServer(async (request, response) => {
    const json = (code, data) => { response.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(data)); };
    const get = (url) => request.method === 'GET' && request.url === url;
    // Only this machine under its own name: keeps out other sites' host names pointed here (DNS rebinding).
    if (!access.hostAllowed(request.headers)) return json(403, failure(msg('m_wrongHost')));
    if (get('/api/ping')) return json(200, { ok: true });
    const font = request.method === 'GET' && request.url.match(FONT);
    if (font && fs.existsSync(path.join(fontsDir, font[1]))) {
      response.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'max-age=31536000, immutable' });
      return response.end(fs.readFileSync(path.join(fontsDir, font[1])));
    }
    // The entry swaps the key for the cookie; everything else is only available with the cookie (see access.js).
    if (request.method === 'GET' && access.entering(request.url)) {
      response.writeHead(302, { location: '/', 'set-cookie': access.cookie, 'cache-control': 'no-store' });
      return response.end();
    }
    if (!access.allowed(request.headers)) return json(403, failure(msg('m_noAccess')));
    if (get('/')) {
      const nonce = newNonce();
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...pageHeaders(nonce) });
      return response.end(page(nonce));
    }
    if (get('/api/status')) return json(200, routes.status());
    if (get('/api/metrics/day')) return json(200, routes.dayMinutes());
    if (get('/api/log')) return json(200, routes.log());
    // The whole file for saving or copying.
    if (get('/api/log/file')) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="runclub.log"', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return response.end(routes.logFile());
    }
    if (get('/api/repos')) {
      try { return json(200, await routes.repos()); } catch (error) { return json(502, failure(reason(error))); }
    }
    if (request.method === 'POST' && request.url.startsWith('/api/')) {
      const name = request.url.slice('/api/'.length);
      const known = actions();
      const action = Object.hasOwn(known, name) ? known[name] : null;
      if (!action) return json(404, failure(msg('m_unknownCall')));
      if (!same(request.headers['x-rc-token'], token)) return json(403, failure(msg('m_pageStale')));
      try { await action(await readBody(request)); return json(200, { ok: true }); } catch (error) { return json(400, failure(reason(error))); }
    }
    return json(404, failure(msg('m_unknownCall')));
  });
}

// Merges the calls from actions.js and those of the app. The same name in two places is an error: otherwise one of
// the two would be silently hidden.
function mergeActions(...sets) {
  const merged = {};
  for (const set of sets) {
    for (const [name, action] of Object.entries(set)) {
      if (Object.hasOwn(merged, name)) throw new Error(`The call ${name} exists twice.`);
      merged[name] = action;
    }
  }
  return merged;
}

module.exports = { createServer, mergeActions, readBody, BODY_MAX };
