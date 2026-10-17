// Read and write JSON files in the data folder without a damaged file preventing the start
// or a crash in the middle of writing leaving half a file behind.

const fs = require('node:fs');

// Returns `{ data, broken }`. If the file cannot be read, a copy stays behind at `broken`
// and `data` is the fallback.
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return { data: fallback, broken: null };
  try {
    return { data: JSON.parse(fs.readFileSync(file, 'utf8')), broken: null };
  } catch {
    const broken = `${file}.broken-${Date.now()}`;
    try { fs.copyFileSync(file, broken); } catch { /* then without a copy */ }
    return { data: fallback, broken };
  }
}

// Write it completely next to it first, then rename. `compact` for large files nobody reads by hand.
function writeJson(file, data, { compact = false } = {}) {
  const draft = `${file}.new`;
  fs.writeFileSync(draft, `${compact ? JSON.stringify(data) : JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(draft, file);
}

module.exports = { readJson, writeJson };
