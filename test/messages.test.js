const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { msg, isMsg, render, Fault, reason, sanitize } = require('../src/messages');

test('render inserts the values: text, number, message, list, time of day', () => {
  assert.equal(render(msg('m_poolSet', msg('m_slotsMany', 3), msg('m_paused'), msg('m_on'))), '3 slots, paused, cache on');
  assert.equal(render(msg('m_quotaTight', 400, 5000, { time: new Date(2026, 9, 13, 17, 5).toISOString() })), 'GitHub requests are getting tight (400 of 5,000 left). Polling less often until 17:05.');
  assert.equal(render(msg('m_vmFree', 2.5)), 'The Docker VM has 2.5 GB memory free again.');
  assert.equal(render(msg('m_planAppliedOwn', '4g', '6g', ['owner/a', 'owner/b'])), 'Limits taken from the measurements: default runner 4g, Docker 6g; own limits for owner/a, owner/b');
});

test('a text stays text; an unknown key stands for itself; a value is not replaced again', () => {
  assert.equal(render('error during connect'), 'error during connect');
  assert.equal(render(msg('m_doesNotExist')), 'm_doesNotExist');
  assert.equal(render(msg('m_jobRun', '{1}', 'pc')), 'Job “{1}” is running on pc');
});

test('Fault carries the message and the English sentence; reason returns the message, otherwise the text', () => {
  const fault = new Fault('m_nameClash', 'owner/App');
  assert.ok(fault instanceof Error);
  assert.deepEqual(fault.msg, { key: 'm_nameClash', args: ['owner/App'] });
  assert.match(fault.message, /^A pool for owner\/App uses the same name/);
  assert.deepEqual(reason(fault), fault.msg);
  assert.equal(reason(new Error('HTTP 502')), 'HTTP 502');
  assert.deepEqual(Fault.of(msg('m_noPool')).msg, msg('m_noPool'));
  assert.equal(Fault.of('broken').message, 'broken');
  assert.equal(isMsg(Fault.of('broken').msg), false);
});

test('sanitize lets only known shapes through, texts cleaned and not arbitrarily deep', () => {
  const clean = (text) => String(text).replace(/\s+/g, ' ');
  assert.equal(sanitize({ key: '__proto__', args: [] }, clean), null);
  assert.equal(sanitize({ key: 'm_noPool' }, clean), null);
  assert.equal(sanitize('m_noPool', clean), null);
  assert.deepEqual(sanitize({ key: 'm_jobRun', args: ['a\nb', { key: 'x y', args: [] }, { time: 'broken' }, Infinity, { other: 1 }] }, clean),
    { key: 'm_jobRun', args: ['a b', '', { time: new Date(0).toISOString() }, 0, '[object Object]'] });
  let deep = msg('m_noPool');
  for (let level = 0; level < 10; level += 1) deep = msg('m_withReason', deep);
  assert.ok(JSON.stringify(sanitize(deep, clean)).length < 200);
});

// The interface forms the sentence with `said` from its tables (ui.html), in German as in English.
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

test('the interface translates messages with their values; texts from outside stay', () => {
  const de = page('de');
  const en = page('en');
  const message = msg('m_jobEnd', 'Build', msg('m_resFail'));
  assert.equal(de(message), 'Job „Build“ – Fehler');
  assert.equal(en(message), render(message));
  assert.equal(en(message), 'Job “Build” – failed');
  assert.equal(en(msg('m_poolSet', msg('m_slotsOne', 1), msg('m_active'), msg('m_off'))), '1 slot, active, cache off');
  assert.equal(en(msg('m_quotaTight', 400, 5000, { time: new Date(2026, 9, 13, 17, 5).toISOString() })), 'GitHub requests are getting tight (400 of 5,000 left). Polling less often until 17:05.');
  assert.equal(en('error during connect'), 'error during connect');
  assert.equal(en(msg('m_withReason', 'Update', 'HTTP 502')), 'Update – HTTP 502');
});
