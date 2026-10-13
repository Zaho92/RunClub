// Namen der Runner-Paare. Ein Paar heißt `rc-<repo>-<kennung>`; seine Container, Volumes und sein Netz tragen
// diesen Namen mit einer Endung. Daran lässt sich erkennen, was zu keinem stehenden Paar mehr gehört.

const PART = /-(runner|dind|seed|work|sock|docker)$/;

// Der Name des Paars, zu dem ein Container, ein Volume oder ein Netz gehört.
const baseOf = (name) => String(name).replace(/^\//, '').replace(PART, '');

// Was von `names` zu keinem der stehenden Paare (`live`: Namen der Paare) gehört. Die Lade-Container der Vorlage
// (`…-loader`) sind keine Paare und bleiben außen vor.
const orphaned = (names, live) => names.map((name) => String(name).replace(/^\//, '')).filter((name) => name && !name.endsWith('-loader') && !live.has(baseOf(name)));

module.exports = { baseOf, orphaned };
