const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { msg, isMsg, render, Fault, reason, sanitize } = require('../src/messages');

test('render setzt die Werte ein: Text, Zahl, Meldung, Liste, Uhrzeit', () => {
  assert.equal(render(msg('m_poolSet', msg('m_slotsMany', 3), msg('m_paused'), msg('m_on'))), '3 Plätze, pausiert, Cache an');
  assert.equal(render(msg('m_quotaTight', 400, 5000, { time: new Date(2026, 9, 13, 17, 5).toISOString() })), 'GitHub-Anfragen werden knapp (400 von 5.000 frei). Bis 17:05 wird seltener abgefragt.');
  assert.equal(render(msg('m_vmFree', 2.5)), 'Die Docker-VM hat wieder 2,5 GB Arbeitsspeicher frei.');
  assert.equal(render(msg('m_planAppliedOwn', '4g', '6g', ['wer/a', 'wer/b'])), 'Limits aus den Messwerten übernommen: Standard Runner 4g, Docker 6g; eigene Limits für wer/a, wer/b');
});

test('ein Text bleibt Text; ein unbekannter Schlüssel steht selbst da; ein Wert wird nicht noch einmal ersetzt', () => {
  assert.equal(render('error during connect'), 'error during connect');
  assert.equal(render(msg('m_gibtsnicht')), 'm_gibtsnicht');
  assert.equal(render(msg('m_jobRun', '{1}', 'pc')), 'Job „{1}“ läuft auf pc');
});

test('Fault trägt die Meldung und den deutschen Satz; reason liefert die Meldung, sonst den Text', () => {
  const fault = new Fault('m_nameClash', 'wer/App');
  assert.ok(fault instanceof Error);
  assert.deepEqual(fault.msg, { key: 'm_nameClash', args: ['wer/App'] });
  assert.match(fault.message, /^Ein Pool für wer\/App belegt/);
  assert.deepEqual(reason(fault), fault.msg);
  assert.equal(reason(new Error('HTTP 502')), 'HTTP 502');
  assert.deepEqual(Fault.of(msg('m_noPool')).msg, msg('m_noPool'));
  assert.equal(Fault.of('kaputt').message, 'kaputt');
  assert.equal(isMsg(Fault.of('kaputt').msg), false);
});

test('sanitize lässt nur bekannte Formen durch, Texte bereinigt und nicht beliebig tief', () => {
  const clean = (text) => String(text).replace(/\s+/g, ' ');
  assert.equal(sanitize({ key: '__proto__', args: [] }, clean), null);
  assert.equal(sanitize({ key: 'm_noPool' }, clean), null);
  assert.equal(sanitize('m_noPool', clean), null);
  assert.deepEqual(sanitize({ key: 'm_jobRun', args: ['a\nb', { key: 'x y', args: [] }, { time: 'kaputt' }, Infinity, { other: 1 }] }, clean),
    { key: 'm_jobRun', args: ['a b', '', { time: new Date(0).toISOString() }, 0, '[object Object]'] });
  let deep = msg('m_noPool');
  for (let level = 0; level < 10; level += 1) deep = msg('m_withReason', deep);
  assert.ok(JSON.stringify(sanitize(deep, clean)).length < 200);
});

// Die Oberfläche bildet den Satz mit `said` aus ihren Tabellen (ui.html), deutsch wie englisch.
function page(lang) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.html'), 'utf8');
  const text = html.match(/const TEXT = (\{\n[\s\S]*?\n\});/)[1];
  const helpers = ['const t = ', 'const said = ', 'const locale = ', 'const hourMinute = '].map((start) => {
    const at = html.indexOf(start);
    assert.ok(at >= 0, start);
    return html.slice(at, html.indexOf(';\n', at) + 2);
  });
  return new Function(`const TEXT = ${text}; const lang = '${lang}';\n${helpers.join('')}return said;`)();
}

test('die Oberfläche übersetzt Meldungen samt Werten; Texte von außen bleiben', () => {
  const de = page('de');
  const en = page('en');
  const message = msg('m_jobEnd', 'Bauen', msg('m_resFail'));
  assert.equal(de(message), render(message));
  assert.equal(en(message), 'Job “Bauen” – failed');
  assert.equal(en(msg('m_poolSet', msg('m_slotsOne', 1), msg('m_active'), msg('m_off'))), '1 slot, active, cache off');
  assert.equal(en(msg('m_quotaTight', 400, 5000, { time: new Date(2026, 9, 13, 17, 5).toISOString() })), 'GitHub requests are getting tight (400 of 5,000 left). Polling less often until 17:05.');
  assert.equal(en('error during connect'), 'error during connect');
  assert.equal(en(msg('m_withReason', 'Update', 'HTTP 502')), 'Update – HTTP 502');
});
