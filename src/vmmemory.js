// Belegung der Docker-VM, wie Linux sie selbst sieht: mit Kernel, Daemon und allem, was keine Container sind.
//
// Gelesen wird die Ausgabe eines Dauerprozesses in der VM, der alle paar Sekunden die Zeilen `MemTotal` und
// `MemAvailable` aus `/proc/meminfo` schreibt und jeden Block mit einem Punkt abschließt (`COMMAND`).
// Belegt ist `MemTotal − MemAvailable`; `MemFree` taugt nicht, weil der Seitencache mehrere GB hält, die Linux
// bei Bedarf sofort hergibt.
//
// Eng ist es, wenn in mehreren Proben in Folge zu wenig frei ist; eine Probe darüber hebt das wieder auf.

const FREE_MIN = 0.15; // darunter gilt der freie Anteil als zu klein
const TIGHT_SAMPLES = 3; // so viele Proben in Folge, bevor gewarnt wird
const MAX_AGE_MS = 15000; // ältere Messwerte gelten nicht mehr
const INTERVAL_S = 2;

// Läuft in der VM. Die Schleife endet von selbst, sobald niemand mehr liest (das Schreiben scheitert dann).
const COMMAND = `while grep -E "^(MemTotal|MemAvailable):" /proc/meminfo && echo .; do sleep ${INTERVAL_S}; done`;

const FIELD = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB$/;

// `block`: { MemTotal, MemAvailable } in Bytes. Liefert `null`, wenn etwas fehlt oder nicht zusammenpasst.
function read(block) {
  const total = block.MemTotal;
  const available = block.MemAvailable;
  if (!(total > 0) || !(available >= 0) || available > total) return null;
  return { total, available, used: total - available };
}

// `now`: die Uhr; in Tests steuerbar.
// `onChange(tight, sample)`: wird gerufen, wenn es eng wird oder nicht mehr eng ist. Fällt die Messung aus,
// während es eng ist, kommt `onChange(false, null)`.
function createVmMemory({ now: clock = Date.now, onChange = () => {} } = {}) {
  let block = {};
  let last = null; // { total, available, used, at }
  let low = 0; // Proben in Folge mit zu wenig freiem Speicher
  let tight = false;

  const turn = (value) => {
    if (tight === value) return;
    tight = value;
    onChange(tight, last);
  };

  // Eine Zeile des Dauerprozesses. Unlesbare Zeilen und unvollständige Blöcke werden übergangen.
  function line(text) {
    if (text !== '.') {
      const match = FIELD.exec(text);
      if (match) block[match[1]] = Number(match[2]) * 1024;
      return;
    }
    const sample = read(block);
    block = {};
    if (!sample) return;
    last = { ...sample, at: clock() };
    low = sample.available / sample.total < FREE_MIN ? low + 1 : 0;
    if (low >= TIGHT_SAMPLES) turn(true); else if (!low) turn(false);
  }

  // Die Messung ist ausgefallen (der Prozess ist zu Ende oder schweigt): Es gilt kein Wert und keine Warnung mehr.
  function drop() {
    block = {};
    last = null;
    low = 0;
    turn(false);
  }

  // Der letzte Messwert, solange er frisch ist; sonst `null`.
  function current() {
    if (last && clock() - last.at > MAX_AGE_MS) drop();
    return last;
  }

  return { line, drop, current, tight: () => Boolean(current()) && tight };
}

module.exports = { createVmMemory, read, COMMAND, MAX_AGE_MS };
