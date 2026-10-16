// Kleine, selbst vergebene Subnetze für die Netze der Paare und der Build-Dienste. Docker hält in der
// Voreinstellung nur rund 30 Bereiche bereit, und manche davon überdecken das Heimnetz. Hier bekommt jedes Netz
// ein zufälliges /28 aus einem eigenen Bereich. Gemerkt wird nichts: Ob ein Subnetz frei ist, entscheidet Docker
// beim Anlegen. Das trägt auch bei zwei Instanzen der App und bei Resten nach einem Absturz.

const DEFAULT_RANGE = '10.213.0.0/16';
const SUBNET_BITS = 28; // 14 Adressen; im Netz eines Paars hängen nur Runner und Docker-Daemon (der Build-Dienst hat ein eigenes)
const SMALLEST_RANGE = 24; // darunter bleiben zu wenige Subnetze, um bei einer Überschneidung auszuweichen
const ATTEMPTS = 10;
const OVERLAP = /Pool overlaps/i;
const EXISTS = /already exists/i;

const address = (number) => [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join('.');

// Liest einen Bereich wie `10.213.0.0/16`: `{ base, prefix, count }` mit der Zahl der /28 darin. `null`, wenn die
// Angabe kein IPv4-Bereich von /8 bis /24 ist. Bits hinter der Maske werden übergangen.
function parseRange(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [a, b, c, d, prefix] = match.slice(1).map(Number);
  if ([a, b, c, d].some((part) => part > 255) || prefix < 8 || prefix > SMALLEST_RANGE) return null;
  const size = 2 ** (32 - prefix);
  const whole = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return { base: whole - (whole % size), prefix, count: size / 2 ** (32 - SUBNET_BITS) };
}

// Der Bereich, aus dem vergeben wird: `RUNCLUB_SUBNETS`, sonst die Vorgabe. Wer ein VPN im 10er-Bereich hat,
// weicht damit aus. Eine ungültige Angabe gilt als nicht gesetzt.
const rangeFrom = (env = process.env) => parseRange(env.RUNCLUB_SUBNETS) ?? parseRange(DEFAULT_RANGE);

// Das n-te /28 des Bereichs (ab 0), `null` außerhalb.
function subnetAt(range, n) {
  if (!Number.isInteger(n) || n < 0 || n >= range.count) return null;
  return `${address(range.base + n * 2 ** (32 - SUBNET_BITS))}/${SUBNET_BITS}`;
}

// Ein zufälliges /28 des Bereichs. `random` liefert wie `Math.random` eine Zahl von 0 bis unter 1.
const pickSubnet = (range, random = Math.random) => subnetAt(range, Math.min(range.count - 1, Math.max(0, Math.floor(random() * range.count))));

// Meldet Docker, dass es ein Netz dieses Namens schon gibt? Das Netz des Build-Dienstes bleibt stehen.
const alreadyExists = (stderr) => EXISTS.test(String(stderr ?? ''));

// Legt ein Netz mit eigenem Subnetz an: `docker network create --subnet <…> <args>`. `docker(args)` liefert
// `{ code, stderr }` (wie `docker` aus engine.js), `args` sind die übrigen Argumente samt Name. Überschneidet sich
// das Subnetz mit einem bestehenden Netz, kommt ein anderes dran, bis zu `attempts` Mal; jeder andere Fehler
// endet sofort. Liefert das letzte Ergebnis von Docker, dazu `subnet` und `tries`.
async function createNetwork(docker, args, { range = rangeFrom(), random = Math.random, attempts = ATTEMPTS } = {}) {
  let result = null;
  let subnet = null;
  let tries = 0;
  do {
    subnet = pickSubnet(range, random);
    tries += 1;
    result = await docker(['network', 'create', '--subnet', subnet, ...args]);
    if (result.code === 0 || !OVERLAP.test(String(result.stderr ?? ''))) return { ...result, subnet, tries };
  } while (tries < attempts);
  const where = `${address(range.base)}/${range.prefix}`;
  return { ...result, subnet, tries, stderr: `${String(result.stderr ?? '').trim()}\nkein freies Subnetz in ${where} nach ${tries} Versuchen (anderer Bereich: RUNCLUB_SUBNETS)` };
}

module.exports = { DEFAULT_RANGE, ATTEMPTS, parseRange, rangeFrom, subnetAt, pickSubnet, alreadyExists, createNetwork };
