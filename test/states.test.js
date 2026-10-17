const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SLOT } = require('../src/states');
const { EN } = require('../src/messages');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.html'), 'utf8');

// An object literal from the page's script as it stands there: on one line, or over several lines up to the
// closing brace at the start of a line.
function literal(name) {
  const found = html.match(new RegExp(`const ${name} = (\\{[^\\n]*\\});`)) ?? html.match(new RegExp(`const ${name} = (\\{\\n[\\s\\S]*?\\n\\});`));
  assert.ok(found, `${name} is not in ui.html`);
  return new Function(`return ${found[1]};`)();
}
const TEXT = literal('TEXT');
const placeholders = (text) => [...new Set(text.match(/\{\d\}/g) ?? [])].sort();

test('every slot state has a word in the interface in both languages', () => {
  for (const lang of ['de', 'en']) {
    for (const state of Object.values(SLOT)) assert.ok(TEXT[lang][`st_${state}`]?.trim(), `${lang}: st_${state}`);
    const extra = Object.keys(TEXT[lang]).filter((key) => key.startsWith('st_') && !Object.values(SLOT).includes(key.slice(3)));
    assert.deepEqual(extra, [], lang);
  }
});

test('the states the interface names itself are named there as in the backend', () => {
  for (const [key, value] of Object.entries(literal('SLOT'))) assert.equal(value, SLOT[key], key);
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
