// Helpers for tests that wait for flows with `await`. Not tests: `node --test` loads the file but finds nothing.

// Yields once to everything that is waiting.
const turn = () => new Promise((resolve) => setImmediate(resolve));

// Waits until `condition()` holds; throws if it has not after many rounds.
async function until(condition) {
  for (let turns = 0; turns < 1000; turns += 1) { if (condition()) return; await turn(); }
  throw new Error('The condition never came true.');
}

// Lets everything run that can run without further input.
async function settle() { for (let turns = 0; turns < 20; turns += 1) await turn(); }

// An entry `[message, repo, kind]` as `log` receives it, with the message as an English sentence (see messages.js).
const { render } = require('../src/messages');
const rendered = ([message, ...rest]) => [render(message), ...rest];

module.exports = { turn, until, settle, rendered };
