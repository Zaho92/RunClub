const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SECCOMP_PROFILE } = require('../src/dind');
const { derive, ADDED } = require('../scripts/seccomp');

const profile = JSON.parse(fs.readFileSync(SECCOMP_PROFILE, 'utf8'));
// Aufrufe, die ohne Bedingung an Rechte oder Argumente erlaubt sind.
const free = new Set(profile.syscalls.filter((rule) => rule.action === 'SCMP_ACT_ALLOW' && !rule.args?.length && !rule.includes?.caps).flatMap((rule) => rule.names));

test('das Profil verbietet, was nicht ausdrücklich erlaubt ist, und erlaubt die Zusätze der Daemons ohne Bedingung', () => {
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  for (const name of ADDED) assert.ok(free.has(name), name);
  // clone3 meldet weiter ENOSYS, damit die C-Bibliothek auf clone ausweicht.
  assert.equal(free.has('clone3'), false);
});

test('was die Daemons nicht brauchen, bleibt so gesperrt wie im Standardprofil', () => {
  for (const name of ['bpf', 'perf_event_open', 'kexec_load', 'init_module', 'open_by_handle_at', 'fsopen', 'move_mount', 'chroot', 'setdomainname', 'add_key', 'request_key']) {
    assert.equal(free.has(name), false, name);
  }
});

test('derive hängt die Zusätze als eine freie Regel an, sonst bleibt das Profil gleich', () => {
  const source = { defaultAction: 'SCMP_ACT_ERRNO', syscalls: [
    { names: ['read'], action: 'SCMP_ACT_ALLOW' },
    { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 2114060288, op: 'SCMP_CMP_MASKED_EQ' }] },
    { names: ['clone3'], action: 'SCMP_ACT_ERRNO', errnoRet: 38 },
    { names: ['bpf', 'clone'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_ADMIN'] } },
  ] };
  assert.deepEqual(derive(source), { ...source, syscalls: [...source.syscalls, { names: ADDED, action: 'SCMP_ACT_ALLOW' }] });
});
