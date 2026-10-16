const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SLOT } = require('../src/states');
const { DE } = require('../src/messages');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.html'), 'utf8');

// Ein Objekt-Literal aus dem Skript der Seite, wie es dort steht: einzeilig, oder über mehrere Zeilen bis zur
// schließenden Klammer am Zeilenanfang.
function literal(name) {
  const found = html.match(new RegExp(`const ${name} = (\\{[^\\n]*\\});`)) ?? html.match(new RegExp(`const ${name} = (\\{\\n[\\s\\S]*?\\n\\});`));
  assert.ok(found, `${name} steht nicht in ui.html`);
  return new Function(`return ${found[1]};`)();
}
const TEXT = literal('TEXT');
const placeholders = (text) => [...new Set(text.match(/\{\d\}/g) ?? [])].sort();

test('jeder Zustand eines Platzes hat in beiden Sprachen ein Wort in der Oberfläche', () => {
  for (const lang of ['de', 'en']) {
    for (const state of Object.values(SLOT)) assert.ok(TEXT[lang][`st_${state}`]?.trim(), `${lang}: st_${state}`);
    const extra = Object.keys(TEXT[lang]).filter((key) => key.startsWith('st_') && !Object.values(SLOT).includes(key.slice(3)));
    assert.deepEqual(extra, [], lang);
  }
});

test('die Zustände, die die Oberfläche selbst nennt, heißen dort wie im Backend', () => {
  for (const [key, value] of Object.entries(literal('SLOT'))) assert.equal(value, SLOT[key], key);
});

test('jede Meldung des Backends steht deutsch wie im Backend und englisch mit denselben Platzhaltern in der Oberfläche', () => {
  for (const [key, german] of Object.entries(DE)) {
    assert.equal(TEXT.de[key], german, `de: ${key}`);
    assert.ok(TEXT.en[key]?.trim(), `en: ${key}`);
    assert.deepEqual(placeholders(TEXT.en[key]), placeholders(german), `en: ${key}`);
  }
  for (const lang of ['de', 'en']) {
    const extra = Object.keys(TEXT[lang]).filter((key) => key.startsWith('m_') && !(key in DE));
    assert.deepEqual(extra, [], lang);
  }
});

test('jede Meldung, die das Backend verwendet, steht im Katalog', () => {
  const dir = path.join(__dirname, '..', 'src');
  const used = new Set();
  for (const name of fs.readdirSync(dir).filter((file) => file.endsWith('.js') && file !== 'messages.js')) {
    for (const [, key] of fs.readFileSync(path.join(dir, name), 'utf8').matchAll(/'(m_\w+)'/g)) used.add(key);
  }
  assert.deepEqual([...used].filter((key) => !(key in DE)), []);
});
