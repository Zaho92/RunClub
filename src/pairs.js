// Names of the runner pairs. A pair is called `rc-<repo>-<id>`; its containers, volumes and its network carry
// this name with a suffix. That shows what no longer belongs to any standing pair.

const PART = /-(runner|dind|seed|work|sock|docker)$/;

// The name of the pair a container, a volume or a network belongs to.
const baseOf = (name) => String(name).replace(/^\//, '').replace(PART, '');

// What of `names` belongs to none of the standing pairs (`live`: names of the pairs). The template's loader containers
// (`…-loader`) are not pairs and are left out.
const orphaned = (names, live) => names.map((name) => String(name).replace(/^\//, '')).filter((name) => name && !name.endsWith('-loader') && !live.has(baseOf(name)));

module.exports = { baseOf, orphaned };
