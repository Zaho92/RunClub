// Small, self-assigned subnets for the networks of the pairs and the build services. By default Docker only keeps
// about 30 ranges ready, and some of them overlap the home network. Here every network gets
// a random /28 from a range of its own. Nothing is remembered: whether a subnet is free is decided by Docker
// on creation. That also holds with two instances of the app and with leftovers after a crash.

const DEFAULT_RANGE = '10.213.0.0/16';
const SUBNET_BITS = 28; // 14 addresses; a pair's network only holds runner and Docker daemon (the build service has its own)
const SMALLEST_RANGE = 24; // below that, too few subnets remain to move aside on an overlap
const ATTEMPTS = 10;
const OVERLAP = /Pool overlaps/i;
const EXISTS = /already exists/i;

const address = (number) => [24, 16, 8, 0].map((shift) => (number >>> shift) & 255).join('.');

// Reads a range like `10.213.0.0/16`: `{ base, prefix, count }` with the number of /28 in it. `null` if the
// value is not an IPv4 range from /8 to /24. Bits behind the mask are ignored.
function parseRange(text) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const [a, b, c, d, prefix] = match.slice(1).map(Number);
  if ([a, b, c, d].some((part) => part > 255) || prefix < 8 || prefix > SMALLEST_RANGE) return null;
  const size = 2 ** (32 - prefix);
  const whole = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return { base: whole - (whole % size), prefix, count: size / 2 ** (32 - SUBNET_BITS) };
}

// The range assigned from: `RUNCLUB_SUBNETS`, otherwise the default. Whoever has a VPN in the 10 range
// moves aside with it. An invalid value counts as not set.
const rangeFrom = (env = process.env) => parseRange(env.RUNCLUB_SUBNETS) ?? parseRange(DEFAULT_RANGE);

// The n-th /28 of the range (from 0), `null` outside.
function subnetAt(range, n) {
  if (!Number.isInteger(n) || n < 0 || n >= range.count) return null;
  return `${address(range.base + n * 2 ** (32 - SUBNET_BITS))}/${SUBNET_BITS}`;
}

// A random /28 of the range. `random` returns a number from 0 to below 1, like `Math.random`.
const pickSubnet = (range, random = Math.random) => subnetAt(range, Math.min(range.count - 1, Math.max(0, Math.floor(random() * range.count))));

// Does Docker report that a network of this name already exists? The build service's network stays.
const alreadyExists = (stderr) => EXISTS.test(String(stderr ?? ''));

// Creates a network with its own subnet: `docker network create --subnet <…> <args>`. `docker(args)` returns
// `{ code, stderr }` (like `docker` from engine.js), `args` are the remaining arguments including the name. If the
// subnet overlaps an existing network, another one is tried, up to `attempts` times; any other error
// ends at once. Returns Docker's last result, plus `subnet` and `tries`.
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
  return { ...result, subnet, tries, stderr: `${String(result.stderr ?? '').trim()}\nno free subnet in ${where} after ${tries} attempts (other range: RUNCLUB_SUBNETS)` };
}

module.exports = { DEFAULT_RANGE, ATTEMPTS, parseRange, rangeFrom, subnetAt, pickSubnet, alreadyExists, createNetwork };
