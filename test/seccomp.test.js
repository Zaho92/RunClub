const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { SECCOMP_PROFILE } = require('../src/dind');
const { derive, ADDED, KEYCTL_OPS } = require('../scripts/seccomp');

const profile = JSON.parse(fs.readFileSync(SECCOMP_PROFILE, 'utf8'));
// Calls allowed without a condition on capabilities or arguments.
const free = new Set(profile.syscalls.filter((rule) => rule.action === 'SCMP_ACT_ALLOW' && !rule.args?.length && !rule.includes?.caps).flatMap((rule) => rule.names));

test('the profile forbids what is not explicitly allowed, and allows the daemons\' additions without a condition', () => {
  assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
  for (const name of ADDED) assert.ok(free.has(name), name);
  // clone3 keeps reporting ENOSYS so that the C library falls back to clone.
  assert.equal(free.has('clone3'), false);
});

test('what the daemons do not need stays as blocked as in the default profile', () => {
  for (const name of ['bpf', 'perf_event_open', 'kexec_load', 'init_module', 'open_by_handle_at', 'fsopen', 'move_mount', 'chroot', 'setdomainname', 'add_key', 'request_key', 'keyctl']) {
    assert.equal(free.has(name), false, name);
  }
});

test('keyctl only for the session keyring runc creates', () => {
  const rules = profile.syscalls.filter((rule) => rule.names.includes('keyctl'));
  assert.ok(rules.every((rule) => rule.action === 'SCMP_ACT_ALLOW' && rule.args.length === 1 && rule.args[0].index === 0 && rule.args[0].op === 'SCMP_CMP_EQ'));
  assert.deepEqual(rules.map((rule) => rule.args[0].value), [1, 5, 6]);
});

test('derive appends the additions as one free rule, plus one per keyctl operation, otherwise the profile stays the same', () => {
  const source = { defaultAction: 'SCMP_ACT_ERRNO', syscalls: [
    { names: ['read'], action: 'SCMP_ACT_ALLOW' },
    { names: ['clone'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value: 2114060288, op: 'SCMP_CMP_MASKED_EQ' }] },
    { names: ['clone3'], action: 'SCMP_ACT_ERRNO', errnoRet: 38 },
    { names: ['bpf', 'clone'], action: 'SCMP_ACT_ALLOW', includes: { caps: ['CAP_SYS_ADMIN'] } },
  ] };
  const keyctl = KEYCTL_OPS.map((value) => ({ names: ['keyctl'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value, op: 'SCMP_CMP_EQ' }] }));
  assert.deepEqual(derive(source), { ...source, syscalls: [...source.syscalls, { names: ADDED, action: 'SCMP_ACT_ALLOW' }, ...keyctl] });
});
