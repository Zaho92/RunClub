// Signed updates: every release carries a small manifest (`runclub-update.json`) and its Ed25519 signature
// (`runclub-update.json.sig`). The manifest names the version, the channel, the installer and its size and SHA-512;
// the signature comes from a key only the maintainer holds (scripts/keygen.js, scripts/release.js), never from CI.
//
// Manifest   JSON, signed as its exact bytes: the signature is verified first, the JSON parsed only afterwards.
//            Fields: type, schema, repo, version, channel, file, size, sha512, commit, signedAt.
// Signature  `{ "key": "<key id>", "sig": "<Base64, 64 bytes>" }`. It covers PREFIX + the manifest's bytes, so a
//            signature over anything else made with the same key never passes as an update.
// Keys       KEYS holds the public keys the app trusts: primary (signs every release) and backup (offline, signs the
//            release that replaces a lost or stolen primary). A key id is the first 8 bytes of the SHA-256 of the raw
//            public key, in hex.
//
// Errors are a Fault with a message (see messages.js). No side effects on load.

const crypto = require('node:crypto');
const { Fault } = require('./messages');
const { compareVersions, parseVersion, channelOf } = require('./versions');

const MANIFEST = 'runclub-update.json';
const SIGNATURE = 'runclub-update.json.sig';
const TYPE = 'runclub-update';
const SCHEMA = 1;
const PREFIX = Buffer.from('RunClub update manifest v1\n');
const MAX_SIZE = 1024 ** 3; // an installer larger than 1 GiB is not one of ours
// Ed25519 public key as SPKI DER: this prefix, then the 32 raw bytes.
const SPKI = Buffer.from('302a300506032b6570032100', 'hex');

// The public keys of this app, written by scripts/keygen.js. Key id → raw public key (Base64).
// KEYS-BEGIN
const KEYS = {
  '62cfc22c9dc3fffb': '4FybMdVUfnwfWQRgo7cK6X0btcCmOm40QTxR3HjNFpA=', // primary
  'f9010f22fefbca1f': 'asy7ws843K5MyYyzh8viI/ZOyPMAVGj4w/KiYkr9D9E=', // backup
};
// KEYS-END

// The raw 32 bytes of a public key; from a private key its public half.
const rawPublicKey = (key) => (key.type === 'public' ? key : crypto.createPublicKey(key)).export({ format: 'der', type: 'spki' }).subarray(SPKI.length);
const keyId = (raw) => crypto.createHash('sha256').update(raw).digest().subarray(0, 8).toString('hex');
const publicKey = (raw) => crypto.createPublicKey({ key: Buffer.concat([SPKI, raw]), format: 'der', type: 'spki' });

// The bytes of a manifest as the release writes them.
function manifestBytes(fields) {
  const { repo, version, file, size, sha512, commit, signedAt } = fields;
  return Buffer.from(`${JSON.stringify({ type: TYPE, schema: SCHEMA, repo, version, channel: channelOf(version), file, size, sha512, commit, signedAt }, null, 2)}\n`);
}

// Signs the manifest's bytes with a private key (KeyObject); returns the text of the signature file.
function sign(bytes, privateKey) {
  const id = keyId(rawPublicKey(privateKey));
  const sig = crypto.sign(null, Buffer.concat([PREFIX, bytes]), privateKey).toString('base64');
  return `${JSON.stringify({ key: id, sig })}\n`;
}

// Verifies the signature over the manifest's bytes against `keys` (key id → Base64) and only then parses the
// manifest. Returns the manifest; throws a Fault if the signature doesn't hold.
function verify(bytes, signatureText, keys = KEYS) {
  let signature;
  try { signature = JSON.parse(String(signatureText)); } catch { throw new Fault('m_sigUnreadable'); }
  const raw = typeof signature?.key === 'string' && Object.hasOwn(keys, signature.key) ? Buffer.from(keys[signature.key], 'base64') : null;
  // The id comes from outside and goes into the log: only what a key id can consist of.
  if (!raw) throw new Fault('m_sigUnknownKey', String(signature?.key ?? '').replace(/[^0-9a-f]/g, '').slice(0, 16) || '–');
  const sig = typeof signature.sig === 'string' ? Buffer.from(signature.sig, 'base64') : Buffer.alloc(0);
  let valid = false;
  try { valid = sig.length === 64 && crypto.verify(null, Buffer.concat([PREFIX, bytes]), publicKey(raw), sig); } catch { valid = false; }
  if (!valid) throw new Fault('m_sigInvalid');
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Fault('m_sigManifestBroken'); }
}

// Checks a verified manifest against the release it came with.
//   repo      “owner/name” the app updates from
//   version   the release's version (from its tag)
//   current   the running version: the manifest's must be newer (no downgrade, no replay of an old release)
//   channel   the updater's channel: “stable” takes no beta
// Returns the manifest; throws a Fault naming the first field that doesn't fit.
function checkManifest(manifest, { repo, version, current, channel }) {
  const m = manifest ?? {};
  const wrong = (field) => new Fault('m_sigManifestWrong', field);
  if (m.type !== TYPE || m.schema !== SCHEMA) throw wrong('type');
  if (typeof m.repo !== 'string' || m.repo.toLowerCase() !== String(repo).toLowerCase()) throw wrong('repo');
  if (typeof m.version !== 'string' || !parseVersion(m.version) || m.version !== version) throw wrong('version');
  if (compareVersions(m.version, current) <= 0) throw wrong('version');
  if (m.channel !== channelOf(m.version) || (channel !== 'beta' && m.channel !== 'stable')) throw wrong('channel');
  if (typeof m.file !== 'string' || !/^[\w.-]+\.exe$/i.test(m.file)) throw wrong('file');
  if (!Number.isSafeInteger(m.size) || m.size <= 0 || m.size > MAX_SIZE) throw wrong('size');
  if (typeof m.sha512 !== 'string' || Buffer.from(m.sha512, 'base64').length !== 64) throw wrong('sha512');
  return m;
}

module.exports = { MANIFEST, SIGNATURE, PREFIX, KEYS, manifestBytes, sign, verify, checkManifest, keyId, rawPublicKey };
