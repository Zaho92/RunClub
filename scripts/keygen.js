// Creates the key pairs that sign RunClub's updates – by the maintainer, in a terminal:
//   node scripts/keygen.js [folder]                 once: primary and backup (default folder: %USERPROFILE%\.runclub-signing)
//   node scripts/keygen.js --new-primary [folder]   after losing the primary: a new one, the backup's public key stays
// Writes `primary.pem` (and `backup.pem`) into the folder, each encrypted with its own passphrase (AES-256), and the
// public keys into src/signature.js. Where to keep what: README, “Signing key”.
// The first form refuses if src/signature.js already carries keys (new keys would lock out every installation); both
// refuse if the folder already holds the key file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { passphrase } = require('./passphrase');
const { KEYS, manifestBytes, sign, verify, keyId, rawPublicKey } = require('../src/signature');

const root = path.join(__dirname, '..');
const source = path.join(root, 'src', 'signature.js');
const rotate = process.argv.includes('--new-primary');
const folder = path.resolve(process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? path.join(os.homedir(), '.runclub-signing'));
const BLOCK = /\/\/ KEYS-BEGIN\r?\n[\s\S]*?\/\/ KEYS-END/;
const MIN = 12;
const fail = (text) => { console.error(text); process.exit(1); };

async function ask(name) {
  for (;;) {
    const first = await passphrase(`Passphrase for the ${name} key (at least ${MIN} characters): `);
    if (first.length < MIN) { console.log('Too short.'); continue; }
    if (await passphrase('Once more: ') === first) return first;
    console.log('The two did not match.');
  }
}

// A new key pair; the private key encrypted with the passphrase into `file`. Returns the line for KEYS.
function create(file, secret, name) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: secret },
  });
  fs.writeFileSync(file, privateKey, { mode: 0o600, flag: 'wx' });
  const raw = rawPublicKey(crypto.createPublicKey(publicKey));
  return { id: keyId(raw), raw: raw.toString('base64'), line: `  '${keyId(raw)}': '${raw.toString('base64')}', // ${name}` };
}

// The file opens with its passphrase and signs something the app accepts with `keys`.
function selfTest(file, secret, keys) {
  const key = crypto.createPrivateKey({ key: fs.readFileSync(file), passphrase: secret });
  const bytes = manifestBytes({ repo: 'test/test', version: '0.0.1', file: 'a.exe', size: 1, sha512: '', commit: '', signedAt: '' });
  verify(bytes, sign(bytes, key), keys);
}

async function main() {
  const text = fs.readFileSync(source, 'utf8');
  if (!BLOCK.test(text)) fail('The markers KEYS-BEGIN/KEYS-END are missing in src/signature.js.');
  // The backup's line as it stands in src/signature.js (marked “// backup”).
  const backupLine = text.match(BLOCK)[0].split(/\r?\n/).find((line) => /\/\/ backup$/.test(line));
  if (!rotate && Object.keys(KEYS).length) fail('src/signature.js already carries keys. New keys would lock out every installation; after losing the primary key: --new-primary.');
  if (rotate && !backupLine) fail('src/signature.js carries no backup key; without it no installation would take a new primary.');
  if (!path.relative(root, folder).startsWith('..')) fail(`${folder} is inside the repo. The private keys must live outside it.`);
  const files = { primary: path.join(folder, 'primary.pem'), backup: path.join(folder, 'backup.pem') };
  for (const name of rotate ? ['primary'] : ['primary', 'backup']) if (fs.existsSync(files[name])) fail(`${files[name]} already exists. Move the old file away first.`);

  const secrets = { primary: await ask('primary') };
  if (!rotate) secrets.backup = await ask('backup');
  if (secrets.primary === secrets.backup) fail('Use two different passphrases.');

  fs.mkdirSync(folder, { recursive: true });
  const primary = create(files.primary, secrets.primary, 'primary');
  const backup = rotate ? null : create(files.backup, secrets.backup, 'backup');
  const keys = { [primary.id]: primary.raw, ...(backup ? { [backup.id]: backup.raw } : {}) };
  selfTest(files.primary, secrets.primary, keys);
  if (backup) selfTest(files.backup, secrets.backup, keys);
  const lines = [primary.line, backup ? backup.line : backupLine];
  fs.writeFileSync(source, text.replace(BLOCK, `// KEYS-BEGIN\nconst KEYS = {\n${lines.join('\n')}\n};\n// KEYS-END`));

  console.log(rotate ? `
Done. src/signature.js now carries the new primary key and the backup key (commit them).

Now, step by step:
  1. Password manager: replace the file and the passphrase in the entry “RunClub signing key (primary)” with
     ${files.primary} and the passphrase you just typed.
  2. Commit, tag and push, then release this version with the backup key from the stick:
     npm run release -- --key <stick>/backup.pem
  3. From the next release on, npm run release signs with the new primary again.
` : `
Done. The public keys are in src/signature.js (commit them).

Now, step by step:
  1. Password manager: a new entry “RunClub signing key (primary)” with the passphrase you just typed and the
     file ${files.primary} as an attachment. The file stays where it is: npm run release reads it from there.
  2. USB stick: copy ${files.backup} onto it, and write the backup passphrase on paper next to the stick
     (not in the same password manager entry as the primary). Keep both offline, in a drawer.
  3. Check the stick holds the file, then delete ${files.backup} from this computer.
`);
}

main().catch((failure) => fail(failure.message));
