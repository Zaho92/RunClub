// Zustände eines Platzes (siehe slots.js). Die Werte sind die Wörter, die die Oberfläche zeigt; für Englisch übersetzt
// sie sie selbst (STATES_EN in ui.html). Ein Platz, der ausläuft, behält seinen Zustand und trägt dazu `retiring`.
const SLOT = Object.freeze({
  STARTING: 'startet',
  READY: 'bereit',
  WORKING: 'arbeitet',
  CLEANING: 'räumt auf',
  BROKEN: 'gestört',
  WAITING: 'wartet',
  PAUSED: 'pausiert',
  NO_DOCKER: 'wartet auf Docker',
  OFF: 'aus',
});

// Ein Platz mit Job oder einer, der gerade abräumt: Er wird nicht unterbrochen, und solange er so ist, wird im Pool
// nichts an Caches und Build-Dienst geändert.
const busy = (slot) => slot.state === SLOT.WORKING || slot.state === SLOT.CLEANING;

module.exports = { SLOT, busy };
