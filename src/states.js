// Zustände eines Platzes (siehe slots.js). Die Werte sind Schlüssel; die Oberfläche zeigt sie als Wort in ihrer
// Sprache (`st_<Zustand>` in ui.html). Ein Platz, der ausläuft, behält seinen Zustand und trägt dazu `retiring`.
const SLOT = Object.freeze({
  STARTING: 'starting',
  READY: 'ready',
  WORKING: 'working',
  CLEANING: 'cleaning',
  BROKEN: 'broken',
  WAITING: 'waiting',
  PAUSED: 'paused',
  NO_DOCKER: 'noDocker',
  OFF: 'off',
});

// Ein Platz mit Job oder einer, der gerade abräumt: Er wird nicht unterbrochen, und solange er so ist, wird im Pool
// nichts an Caches und Build-Dienst geändert.
const busy = (slot) => slot.state === SLOT.WORKING || slot.state === SLOT.CLEANING;

module.exports = { SLOT, busy };
