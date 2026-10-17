const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_RANGE, ATTEMPTS, parseRange, rangeFrom, subnetAt, pickSubnet, alreadyExists, createNetwork } = require('../src/subnets');

const OVERLAP = 'Error response from daemon: invalid pool request: Pool overlaps with other one on this address space';
// A simulated Docker: answers with `answers` in turn and remembers the calls.
function fakeDocker(answers) {
  const calls = [];
  const docker = async (args) => { calls.push(args); return answers[Math.min(calls.length, answers.length) - 1]; };
  return { docker, calls };
}
const ok = { code: 0, stdout: 'abc\n', stderr: '' };
const overlap = { code: 1, stdout: '', stderr: OVERLAP };
// Is `subnet` a valid /28 inside the range?
function inside(range, subnet) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/28$/.exec(subnet);
  if (!match) return false;
  const [a, b, c, d] = match.slice(1).map(Number);
  const number = a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d;
  return [a, b, c, d].every((part) => part <= 255) && number % 16 === 0 && number >= range.base && number + 16 <= range.base + 2 ** (32 - range.prefix);
}

test('reads a range and counts its /28', () => {
  assert.deepEqual(parseRange('10.213.0.0/16'), { base: 10 * 2 ** 24 + 213 * 2 ** 16, prefix: 16, count: 4096 });
  assert.equal(parseRange(' 192.168.77.0/24 ').count, 16);
  assert.equal(parseRange('10.0.0.0/8').count, 2 ** 20);
});

test('bits behind the mask do not count, above 128 too', () => {
  assert.deepEqual(parseRange('10.213.7.9/16'), parseRange('10.213.0.0/16'));
  assert.equal(subnetAt(parseRange('192.168.77.200/24'), 0), '192.168.77.0/28');
  assert.equal(subnetAt(parseRange('255.255.255.255/24'), 15), '255.255.255.240/28');
});

test('what is not a range from /8 to /24 does not count', () => {
  for (const text of ['', undefined, null, 'nonsense', '10.213.0.0', '10.213.0.0/', '10.213.0/16', '10.256.0.0/16', '10.213.0.0/25', '10.213.0.0/28', '10.213.0.0/7', '10.213.0.0/33', 'fd00::/64', '10.213.0.0/16 x', '-1.2.3.4/16']) {
    assert.equal(parseRange(text), null, String(text));
  }
});

test('the n-th /28: first, last, carry into the next octet and the limits', () => {
  const range = parseRange(DEFAULT_RANGE);
  assert.equal(subnetAt(range, 0), '10.213.0.0/28');
  assert.equal(subnetAt(range, 1), '10.213.0.16/28');
  assert.equal(subnetAt(range, 15), '10.213.0.240/28');
  assert.equal(subnetAt(range, 16), '10.213.1.0/28');
  assert.equal(subnetAt(range, 4095), '10.213.255.240/28');
  assert.equal(subnetAt(range, 4096), null);
  assert.equal(subnetAt(range, -1), null);
  assert.equal(subnetAt(range, 1.5), null);
});

test('every /28 is inside the range, and none comes twice', () => {
  for (const text of [DEFAULT_RANGE, '192.168.77.0/24', '172.20.0.0/20']) {
    const range = parseRange(text);
    const all = new Set();
    for (let n = 0; n < range.count; n += 1) {
      const subnet = subnetAt(range, n);
      assert.ok(inside(range, subnet), `${text} ${n}: ${subnet}`);
      all.add(subnet);
    }
    assert.equal(all.size, range.count);
  }
});

test('the random pick covers the whole range and stays inside it at the edges', () => {
  const range = parseRange(DEFAULT_RANGE);
  assert.equal(pickSubnet(range, () => 0), '10.213.0.0/28');
  assert.equal(pickSubnet(range, () => 0.5), '10.213.128.0/28');
  assert.equal(pickSubnet(range, () => 0.999999999), '10.213.255.240/28');
  assert.equal(pickSubnet(range, () => 1), '10.213.255.240/28');
  for (let i = 0; i < 500; i += 1) assert.ok(inside(range, pickSubnet(range)));
});

test('the environment variable replaces the default, an invalid value does not', () => {
  assert.deepEqual(rangeFrom({}), parseRange(DEFAULT_RANGE));
  assert.deepEqual(rangeFrom({ RUNCLUB_SUBNETS: '172.30.0.0/16' }), parseRange('172.30.0.0/16'));
  assert.deepEqual(rangeFrom({ RUNCLUB_SUBNETS: 'nonsense' }), parseRange(DEFAULT_RANGE));
  assert.deepEqual(rangeFrom({ RUNCLUB_SUBNETS: '10.0.0.0/30' }), parseRange(DEFAULT_RANGE));
  assert.deepEqual(rangeFrom({ RUNCLUB_SUBNETS: '' }), parseRange(DEFAULT_RANGE));
});

test('creates the network with a subnet and leaves the other arguments as they are', async () => {
  const { docker, calls } = fakeDocker([ok]);
  const result = await createNetwork(docker, ['--label', 'runclub.runner=abc', 'rc-jade-71dcf1'], { range: parseRange(DEFAULT_RANGE), random: () => 0 });
  assert.deepEqual(calls, [['network', 'create', '--subnet', '10.213.0.0/28', '--label', 'runclub.runner=abc', 'rc-jade-71dcf1']]);
  assert.deepEqual(result, { ...ok, subnet: '10.213.0.0/28', tries: 1 });
});

test('if the subnet overlaps, another one is tried', async () => {
  const { docker, calls } = fakeDocker([overlap, overlap, ok]);
  const draws = [0, 0.25, 0.5];
  const result = await createNetwork(docker, ['net'], { range: parseRange(DEFAULT_RANGE), random: () => draws.shift() });
  assert.deepEqual(calls.map((args) => args[3]), ['10.213.0.0/28', '10.213.64.0/28', '10.213.128.0/28']);
  assert.equal(result.code, 0);
  assert.equal(result.subnet, '10.213.128.0/28');
  assert.equal(result.tries, 3);
});

test('any other error ends at once', async () => {
  for (const stderr of ['Error response from daemon: network with name net already exists', 'no answer after 300 s', '']) {
    const { docker, calls } = fakeDocker([{ code: 1, stdout: '', stderr }, ok]);
    const result = await createNetwork(docker, ['net'], { range: parseRange(DEFAULT_RANGE) });
    assert.equal(calls.length, 1, stderr);
    assert.equal(result.code, 1);
    assert.equal(result.stderr, stderr);
    assert.equal(result.tries, 1);
  }
});

test('gives up after the maximum and says why', async () => {
  const { docker, calls } = fakeDocker([overlap]);
  const result = await createNetwork(docker, ['net'], { range: parseRange('192.168.77.0/24') });
  assert.equal(calls.length, ATTEMPTS);
  assert.equal(result.code, 1);
  assert.equal(result.tries, ATTEMPTS);
  assert.match(result.stderr, /Pool overlaps/);
  assert.equal(result.stderr.trim().split('\n').pop(), `no free subnet in 192.168.77.0/24 after ${ATTEMPTS} attempts (other range: RUNCLUB_SUBNETS)`);

  const short = fakeDocker([overlap]);
  assert.equal((await createNetwork(short.docker, ['net'], { range: parseRange(DEFAULT_RANGE), attempts: 3 })).tries, 3);
  assert.equal(short.calls.length, 3);
});

test('without options the range from the environment applies', async () => {
  const before = process.env.RUNCLUB_SUBNETS;
  process.env.RUNCLUB_SUBNETS = '172.30.5.0/24';
  try {
    const { docker, calls } = fakeDocker([ok]);
    await createNetwork(docker, ['net']);
    assert.match(calls[0][3], /^172\.30\.5\.\d+\/28$/);
  } finally {
    if (before === undefined) delete process.env.RUNCLUB_SUBNETS; else process.env.RUNCLUB_SUBNETS = before;
  }
});

test('recognizes that a network of this name already exists', () => {
  assert.equal(alreadyExists('Error response from daemon: network with name rc-buildnet-jade already exists'), true);
  assert.equal(alreadyExists(OVERLAP), false);
  assert.equal(alreadyExists(undefined), false);
});
