// Usage of the Docker VM as Linux itself sees it: with kernel, daemon and everything that is not a container.
//
// What is read is the output of a long-running process in the VM that every few seconds writes the lines `MemTotal` and
// `MemAvailable` from `/proc/meminfo` and ends each block with a dot (`COMMAND`).
// Used is `MemTotal − MemAvailable`; `MemFree` is no good because the page cache holds several GB that Linux
// gives up at once when needed.
//
// It is tight when too little is free in several samples in a row; one sample above that lifts it again.

const { SECOND } = require('./units');

const FREE_MIN = 0.15; // below this the free share counts as too small
const TIGHT_SAMPLES = 3; // this many samples in a row before warning
const MAX_AGE = 15 * SECOND; // older measurements no longer count
const INTERVAL_S = 2;

// Runs in the VM. The loop ends by itself as soon as nobody reads anymore (writing then fails).
const COMMAND = `while grep -E "^(MemTotal|MemAvailable):" /proc/meminfo && echo .; do sleep ${INTERVAL_S}; done`;

const FIELD = /^(MemTotal|MemAvailable):\s+(\d+)\s*kB$/;

// `block`: { MemTotal, MemAvailable } in bytes. Returns `null` if something is missing or does not fit.
function read(block) {
  const total = block.MemTotal;
  const available = block.MemAvailable;
  if (!(total > 0) || !(available >= 0) || available > total) return null;
  return { total, available, used: total - available };
}

// `now`: the clock; controllable in tests.
// `onChange(tight, sample)`: is called when it gets tight or is no longer tight. If the measurement fails
// while it is tight, `onChange(false, null)` comes.
function createVmMemory({ now: clock = Date.now, onChange = () => {} } = {}) {
  let block = {};
  let last = null; // { total, available, used, at }
  let low = 0; // samples in a row with too little free memory
  let tight = false;

  const turn = (value) => {
    if (tight === value) return;
    tight = value;
    onChange(tight, last);
  };

  // One line of the long-running process. Unreadable lines and incomplete blocks are skipped.
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

  // The measurement has failed (the process has ended or is silent): no value and no warning apply anymore.
  function drop() {
    block = {};
    last = null;
    low = 0;
    turn(false);
  }

  // The last measurement, as long as it is fresh; otherwise `null`.
  function current() {
    if (last && clock() - last.at > MAX_AGE) drop();
    return last;
  }

  return { line, drop, current, tight: () => Boolean(current()) && tight };
}

module.exports = { createVmMemory, read, COMMAND, MAX_AGE };
