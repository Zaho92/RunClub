// The interface's texts outside the page: the tray icon's menu and tooltip (main.js). The tables in ui.html (`TEXT`)
// stay the only place for texts in both languages; this module reads them from there, as the tests do. No side
// effects on load: the file is read on the first call.

const fs = require('node:fs');
const path = require('node:path');

const UI = path.join(__dirname, 'ui.html');

// An object literal from the page's script as it stands there: on one line, or over several lines up to the closing
// brace at the start of a line. Returns null if there is none.
function literal(html, name) {
  const found = html.match(new RegExp(`const ${name} = (\\{[^\\n]*\\});`)) ?? html.match(new RegExp(`const ${name} = (\\{\\n[\\s\\S]*?\\n\\});`));
  return found ? new Function(`return ${found[1]};`)() : null;
}

// `t(key, ...args)` in a language (`de` or `en`, otherwise English), with placeholders `{0}` as in ui.html. If the
// tables can't be read (their layout changed; test/states.test.js notices), the keys show instead of a broken tray.
function textsIn(lang, html = fs.readFileSync(UI, 'utf8')) {
  let tables;
  try { tables = literal(html, 'TEXT') ?? {}; } catch { tables = {}; }
  const table = tables[lang] ?? tables.en ?? {};
  return (key, ...args) => (table[key] ?? key).replace(/\{(\d)\}/g, (_, i) => args[i]);
}

module.exports = { literal, textsIn };
