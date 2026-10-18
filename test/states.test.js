const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SLOT, countRunners } = require('../src/states');
const { EN } = require('../src/messages');
const auth = require('../src/auth');
const { literal: read, textsIn } = require('../src/texts');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.html'), 'utf8');

// An object literal from the page's script as it stands there (see texts.js).
function literal(name) {
  const found = read(html, name);
  assert.ok(found, `${name} is not in ui.html`);
  return found;
}
const TEXT = literal('TEXT');
const placeholders = (text) => [...new Set(text.match(/\{\d\}/g) ?? [])].sort();

test('runners are counted per state across all projects', () => {
  const status = { repos: [{ runners: [{ state: SLOT.WORKING }, { state: SLOT.READY }] }, { runners: [{ state: SLOT.WORKING }] }, { runners: [] }] };
  assert.equal(countRunners(status, SLOT.WORKING), 2);
  assert.equal(countRunners(status, SLOT.READY), 1);
  assert.equal(countRunners({ repos: [] }, SLOT.WORKING), 0);
});

test('every slot state has a word in the interface in both languages', () => {
  for (const lang of ['de', 'en']) {
    for (const state of Object.values(SLOT)) assert.ok(TEXT[lang][`st_${state}`]?.trim(), `${lang}: st_${state}`);
    const extra = Object.keys(TEXT[lang]).filter((key) => key.startsWith('st_') && !Object.values(SLOT).includes(key.slice(3)));
    assert.deepEqual(extra, [], lang);
  }
});

test('the states the interface names itself are named there as in the backend', () => {
  // The interface names only the states it treats on its own.
  for (const [name, backend] of [['SLOT', SLOT], ['SIGN_IN', auth.STATE], ['FLOW', auth.FLOW], ['WHY', auth.WHY]]) {
    for (const [key, value] of Object.entries(literal(name))) assert.equal(value, backend[key], `${name}.${key}`);
  }
});

test('the tray icon has its texts in both languages, with the same placeholders', () => {
  for (const key of ['open', 'closing', 'autostart', 'quit', 'stopping', 'count']) {
    assert.ok(TEXT.en[`tray_${key}`]?.trim(), `en: tray_${key}`);
    assert.deepEqual(placeholders(TEXT.de[`tray_${key}`] ?? ''), placeholders(TEXT.en[`tray_${key}`]), `de: tray_${key}`);
  }
  assert.equal(textsIn('de')('tray_count', 2, 3), 'RunClub – 2 arbeiten, 3 bereit');
  assert.equal(textsIn('fr')('tray_open'), 'Open RunClub');
  assert.equal(textsIn('de', '<script>const TEXT = changed;</script>')('tray_open'), 'tray_open');
  assert.equal(textsIn('de', '<script>const TEXT = { de: { tray_open: } };</script>')('tray_open'), 'tray_open');
});

test('every backend message is in the interface in English as in the backend and in German with the same placeholders', () => {
  for (const [key, english] of Object.entries(EN)) {
    assert.equal(TEXT.en[key], english, `en: ${key}`);
    assert.ok(TEXT.de[key]?.trim(), `de: ${key}`);
    assert.deepEqual(placeholders(TEXT.de[key]), placeholders(english), `de: ${key}`);
  }
  for (const lang of ['de', 'en']) {
    const extra = Object.keys(TEXT[lang]).filter((key) => key.startsWith('m_') && !(key in EN));
    assert.deepEqual(extra, [], lang);
  }
});

test('every message the backend uses is in the catalogue', () => {
  const dir = path.join(__dirname, '..', 'src');
  const used = new Set();
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.js') && file !== 'messages.js')) {
    for (const [, key] of fs.readFileSync(path.join(dir, name), 'utf8').matchAll(/'(m_\w+)'/g)) used.add(key);
  }
  assert.deepEqual([...used].filter((key) => !(key in EN)), []);
});

test('every error code of the updater is known to the interface and has its texts in both languages', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'updater.js'), 'utf8');
  const codes = [...new Set([...source.matchAll(/UpdateError\('(\w+)'/g)].map((match) => match[1])), 'other'];
  const listed = JSON.parse(html.match(/const failCode = [^\n]*?(\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.deepEqual([...listed].sort(), [...codes].sort());
  for (const lang of ['de', 'en']) {
    for (const code of codes) for (const key of [`updFail_${code}`, `updWhy_${code}`]) assert.ok(TEXT[lang][key]?.trim(), `${lang}: ${key}`);
  }
});
