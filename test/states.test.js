const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { SLOT } = require('../src/states');

// Ein Objekt-Literal aus dem Skript der Seite, wie es dort steht.
function literal(name) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.html'), 'utf8');
  const found = html.match(new RegExp(`const ${name} = (\{[^\n]*\});`));
  assert.ok(found, `${name} steht nicht in ui.html`);
  return new Function(`return ${found[1]};`)();
}

test('jeder Zustand eines Platzes hat ein englisches Wort in der Oberfläche, und es gibt keine übrigen', () => {
  const english = literal('STATES_EN');
  assert.deepEqual(Object.keys(english).sort(), Object.values(SLOT).sort());
  for (const word of Object.values(english)) assert.ok(word.trim(), 'leeres Wort');
});

test('die Zustände, die die Oberfläche selbst nennt, heißen dort wie im Backend', () => {
  for (const [key, value] of Object.entries(literal('SLOT'))) assert.equal(value, SLOT[key], key);
});
