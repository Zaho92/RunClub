// JSON-Dateien im Datenordner lesen und schreiben, ohne dass eine beschädigte Datei den Start verhindert
// oder ein Absturz mitten im Schreiben eine halbe Datei hinterlässt.

const fs = require('node:fs');

// Liefert `{ data, broken }`. Lässt sich die Datei nicht lesen, bleibt eine Kopie unter `broken` liegen
// und `data` ist der Ersatzwert.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return { data: fallback, broken: null };
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), broken: null };
  } catch {
    const broken = `${file}.kaputt-${Date.now()}`;
    try { fs.copyFileSync(file, broken); } catch { /* dann eben ohne Kopie */ }
    return { data: fallback, broken };
  }
}

// Erst vollständig daneben schreiben, dann umbenennen.
function writeJson(file, data) {
  const draft = `${file}.neu`;
  fs.writeFileSync(draft, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(draft, file);
}

module.exports = { readJson, writeJson };
