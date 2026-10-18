// States of a slot (see slots.js). The values are keys; the interface shows them as a word in its own
// language (`st_<state>` in ui.html). A slot that is retiring keeps its state and also carries `retiring`.
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

// A slot with a job or one that is cleaning up: it is not interrupted, and as long as it is, nothing about the pool's
// caches and build service is changed.
const busy = (slot) => slot.state === SLOT.WORKING || slot.state === SLOT.CLEANING;

// How many runners in a status (`repos[].runners[].state`, see status.js) are in a state.
const countRunners = (status, state) => status.repos.flatMap((repo) => repo.runners).filter((runner) => runner.state === state).length;

module.exports = { SLOT, busy, countRunners };
