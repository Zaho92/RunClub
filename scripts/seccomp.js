// Writes linux/seccomp.json: Docker's default profile, extended by what the daemons without privileges need (the daemon
// of a pair, the template's loader daemon, the build service; see src/dind.js). Rootlesskit and buildkit create their own
// namespaces, mount file systems inside them and change the root; the default profile allows that only with
// CAP_SYS_ADMIN, and the daemons don't get it.
//
// Determined on 2026-10-16 with Docker 29.6.1 (profile from moby/profiles v0.2.3): each addition left out on its own, then
// the daemon's start failed (clone, unshare, setns, mount) or a job container, a build or a published
// port did (umount2, pivot_root, keyctl, sethostname). runc needs `keyctl` only to give each container its own
// session keyring (KEYCTL_JOIN_SESSION_KEYRING, then KEYCTL_DESCRIBE and KEYCTL_SETPERM); only these three
// operations are allowed (tested likewise: daemon, container with port, exec, build in the daemon and in the build service).
// Without `keyctl` every container fails with "unable to join session keyring". Not needed were the new mount API (fsopen, fsmount, move_mount,
// open_tree, mount_setattr), chroot and setdomainname. Whatever a job starts in the inner daemon gets that daemon's
// own default profile there again.
//
// Usage: node scripts/seccomp.js <default.json>
// <default.json> from moby/moby, tag docker-v<version of Docker Desktop>, vendor/github.com/moby/profiles/seccomp/default.json.

const fs = require('node:fs');
const path = require('node:path');

const ADDED = ['clone', 'unshare', 'setns', 'mount', 'umount2', 'pivot_root', 'sethostname'];
// Allowed operations of keyctl (first argument): JOIN_SESSION_KEYRING, SETPERM, DESCRIBE from linux/keyctl.h.
const KEYCTL_OPS = [1, 5, 6];
const TARGET = path.join(__dirname, '..', 'linux', 'seccomp.json');

// The default profile plus one rule that allows the additions without condition, and one each for the operations of
// keyctl (the conditions of a rule apply together, hence one rule per value). The default profile's rule that allows
// `clone` only without namespace flags may stay: it allows as well, and the unconditional rule applies alongside
// (tested). `clone3` stays at ENOSYS; the C library then uses `clone`.
function derive(profile) {
  const keyctl = KEYCTL_OPS.map((value) => ({ names: ['keyctl'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value, op: 'SCMP_CMP_EQ' }] }));
  return { ...profile, syscalls: [...profile.syscalls, { names: ADDED, action: 'SCMP_ACT_ALLOW' }, ...keyctl] };
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) { console.error('Usage: node scripts/seccomp.js <default.json>'); process.exit(1); }
  const profile = derive(JSON.parse(fs.readFileSync(source, 'utf8')));
  fs.writeFileSync(TARGET, `${JSON.stringify(profile, null, '\t')}\n`);
  console.log(`${path.relative(process.cwd(), TARGET)} written`);
}

module.exports = { derive, ADDED, KEYCTL_OPS };
