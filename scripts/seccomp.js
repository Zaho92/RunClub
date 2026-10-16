// Schreibt linux/seccomp.json: Dockers Standardprofil, ergänzt um das, was die Daemons ohne Rechte brauchen (der Daemon
// eines Paars, der Lade-Daemon der Vorlage, der Build-Dienst; siehe src/dind.js). Rootlesskit und buildkit legen eigene
// Namensräume an, hängen darin Dateisysteme ein und wechseln die Wurzel; das Standardprofil erlaubt das nur mit
// CAP_SYS_ADMIN, und die bekommen die Daemons nicht.
//
// Ermittelt am 16.10.2026 mit Docker 29.6.1 (Profil aus moby/profiles v0.2.3): jeder Zusatz einzeln weggelassen, dann
// scheiterte der Start des Daemons (clone, unshare, setns, mount) oder ein Job-Container, ein Build oder ein veröffentlichter
// Port (umount2, pivot_root, keyctl, sethostname). `keyctl` braucht runc nur, um jedem Container einen eigenen
// Sitzungsschlüsselbund zu geben (KEYCTL_JOIN_SESSION_KEYRING, dann KEYCTL_DESCRIBE und KEYCTL_SETPERM); nur diese drei
// Operationen sind erlaubt (erprobt ebenso: Daemon, Container mit Port, exec, Build im Daemon und im Build-Dienst).
// Ohne `keyctl` scheitert jeder Container mit „unable to join session keyring“. Nicht nötig waren die neue Mount-API (fsopen, fsmount, move_mount,
// open_tree, mount_setattr), chroot und setdomainname. Was ein Job im inneren Daemon startet, bekommt dort wieder dessen
// eigenes Standardprofil.
//
// Aufruf: node scripts/seccomp.js <default.json>
// <default.json> aus moby/moby, Tag docker-v<Version von Docker Desktop>, vendor/github.com/moby/profiles/seccomp/default.json.

const fs = require('node:fs');
const path = require('node:path');

const ADDED = ['clone', 'unshare', 'setns', 'mount', 'umount2', 'pivot_root', 'sethostname'];
// Erlaubte Operationen von keyctl (erstes Argument): JOIN_SESSION_KEYRING, SETPERM, DESCRIBE aus linux/keyctl.h.
const KEYCTL_OPS = [1, 5, 6];
const TARGET = path.join(__dirname, '..', 'linux', 'seccomp.json');

// Das Standardprofil mit einer Regel dazu, die die Zusätze ohne Bedingung erlaubt, und je einer für die Operationen von
// keyctl (Bedingungen einer Regel gelten zugleich, also eine Regel je Wert). Die Regel des Standardprofils, die
// `clone` nur ohne Namensraum-Flags erlaubt, darf bleiben: Sie erlaubt ebenfalls, und die freie Regel gilt daneben
// (erprobt). `clone3` bleibt bei ENOSYS; die C-Bibliothek nimmt dann `clone`.
function derive(profile) {
  const keyctl = KEYCTL_OPS.map((value) => ({ names: ['keyctl'], action: 'SCMP_ACT_ALLOW', args: [{ index: 0, value, op: 'SCMP_CMP_EQ' }] }));
  return { ...profile, syscalls: [...profile.syscalls, { names: ADDED, action: 'SCMP_ACT_ALLOW' }, ...keyctl] };
}

if (require.main === module) {
  const source = process.argv[2];
  if (!source) { console.error('Aufruf: node scripts/seccomp.js <default.json>'); process.exit(1); }
  const profile = derive(JSON.parse(fs.readFileSync(source, 'utf8')));
  fs.writeFileSync(TARGET, `${JSON.stringify(profile, null, '\t')}\n`);
  console.log(`${path.relative(process.cwd(), TARGET)} geschrieben`);
}

module.exports = { derive, ADDED, KEYCTL_OPS };
