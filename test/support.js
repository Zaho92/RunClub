// Hilfen für Tests, die auf Abläufe mit `await` warten. Keine Tests: `node --test` lädt die Datei, findet aber nichts.

// Gibt einmal an alles ab, was gerade wartet.
const turn = () => new Promise((resolve) => setImmediate(resolve));

// Wartet, bis `condition()` gilt; wirft, wenn es nach vielen Runden nicht so weit ist.
async function until(condition) {
  for (let turns = 0; turns < 1000; turns += 1) { if (condition()) return; await turn(); }
  throw new Error('Die Bedingung trat nicht ein.');
}

// Lässt alles laufen, was ohne weiteres Zutun laufen kann.
async function settle() { for (let turns = 0; turns < 20; turns += 1) await turn(); }

// Ein Eintrag `[message, repo, kind]`, wie ihn `log` bekommt, mit der Meldung als deutschem Satz (siehe messages.js).
const { render } = require('../src/messages');
const rendered = ([message, ...rest]) => [render(message), ...rest];

module.exports = { turn, until, settle, rendered };
