const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { manifestBytes, sign, verify, checkManifest, keyId, rawPublicKey, KEYS } = require('../src/signature');
const { render } = require('../src/messages');

// A key pair as the app knows it: id → raw public key (Base64).
function pair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = rawPublicKey(publicKey);
  return { privateKey, id: keyId(raw), keys: { [keyId(raw)]: raw.toString('base64') } };
}

const fields = (over = {}) => ({
  repo: 'owner/RunClub', version: '0.2.0-beta.1', file: 'RunClub-Setup-0.2.0-beta.1.exe', size: 1234,
  sha512: crypto.createHash('sha512').update('x').digest('base64'), commit: 'a'.repeat(40), signedAt: '2026-10-18T12:00:00.000Z', ...over,
});
const release = { repo: 'owner/RunClub', version: '0.2.0-beta.1', current: '0.1.0-beta.5', channel: 'beta' };
const fault = (key) => (failure) => failure.msg?.key === key;

test('a manifest signed with a known key verifies and reads back', () => {
  const primary = pair();
  const bytes = manifestBytes(fields());
  const manifest = verify(bytes, sign(bytes, primary.privateKey), primary.keys);
  assert.equal(manifest.version, '0.2.0-beta.1');
  assert.equal(manifest.channel, 'beta');
  assert.equal(manifest.type, 'runclub-update');
  assert.deepEqual(checkManifest(manifest, release), manifest);
  assert.equal(JSON.parse(sign(bytes, primary.privateKey)).key, primary.id);
});

test('the backup key is accepted as well as the primary', () => {
  const primary = pair();
  const backup = pair();
  const keys = { ...primary.keys, ...backup.keys };
  const bytes = manifestBytes(fields());
  assert.equal(verify(bytes, sign(bytes, backup.privateKey), keys).version, '0.2.0-beta.1');
});

test('a key the app doesn\'t know is refused, even with a correct signature', () => {
  const primary = pair();
  const stranger = pair();
  const bytes = manifestBytes(fields());
  assert.throws(() => verify(bytes, sign(bytes, stranger.privateKey), primary.keys), fault('m_sigUnknownKey'));
  // Claiming the known key id with a stranger's signature doesn't help.
  const forged = JSON.stringify({ key: primary.id, sig: JSON.parse(sign(bytes, stranger.privateKey)).sig });
  assert.throws(() => verify(bytes, forged, primary.keys), fault('m_sigInvalid'));
});

test('a changed manifest no longer verifies', () => {
  const primary = pair();
  const bytes = manifestBytes(fields());
  const sig = sign(bytes, primary.privateKey);
  const tampered = Buffer.from(bytes.toString('utf8').replace('"size": 1234', '"size": 9999'));
  assert.throws(() => verify(tampered, sig, primary.keys), fault('m_sigInvalid'));
});

test('a signature over the bare manifest without the prefix doesn\'t count', () => {
  const primary = pair();
  const bytes = manifestBytes(fields());
  const bare = JSON.stringify({ key: primary.id, sig: crypto.sign(null, bytes, primary.privateKey).toString('base64') });
  assert.throws(() => verify(bytes, bare, primary.keys), fault('m_sigInvalid'));
});

test('an unreadable or empty signature is refused', () => {
  const primary = pair();
  const bytes = manifestBytes(fields());
  assert.throws(() => verify(bytes, 'not json', primary.keys), fault('m_sigUnreadable'));
  assert.throws(() => verify(bytes, JSON.stringify({ key: primary.id, sig: '' }), primary.keys), fault('m_sigInvalid'));
  assert.throws(() => verify(bytes, JSON.stringify({ key: 'toString', sig: '' }), primary.keys), fault('m_sigUnknownKey'));
});

test('without embedded keys nothing verifies', () => {
  const primary = pair();
  const bytes = manifestBytes(fields());
  assert.throws(() => verify(bytes, sign(bytes, primary.privateKey), {}), fault('m_sigUnknownKey'));
});

test('a signed manifest that doesn\'t fit the release is refused', () => {
  const manifest = (over) => JSON.parse(manifestBytes(fields(over)).toString('utf8'));
  const wrong = (field) => (failure) => failure.msg?.key === 'm_sigManifestWrong' && failure.msg.args[0] === field;
  // An older signed release under a newer tag (replay).
  assert.throws(() => checkManifest(manifest({ version: '0.1.0-beta.4' }), { ...release, version: '0.2.0-beta.1' }), wrong('version'));
  // Not newer than the running version (downgrade).
  assert.throws(() => checkManifest(manifest(), { ...release, current: '0.2.0-beta.1' }), wrong('version'));
  assert.throws(() => checkManifest(manifest(), { ...release, current: '0.2.0' }), wrong('version'));
  // A beta never in channel stable.
  assert.throws(() => checkManifest(manifest(), { ...release, channel: 'stable' }), wrong('channel'));
  assert.throws(() => checkManifest({ ...manifest(), channel: 'stable' }, release), wrong('channel'));
  assert.throws(() => checkManifest(manifest({ repo: 'other/RunClub' }), release), wrong('repo'));
  assert.throws(() => checkManifest({ ...manifest(), type: 'something-else' }, release), wrong('type'));
  assert.throws(() => checkManifest(manifest({ file: '..\\evil.exe' }), release), wrong('file'));
  assert.throws(() => checkManifest(manifest({ file: 'RunClub.msi' }), release), wrong('file'));
  assert.throws(() => checkManifest(manifest({ size: 0 }), release), wrong('size'));
  assert.throws(() => checkManifest(manifest({ sha512: 'short' }), release), wrong('sha512'));
  // The repo's name is compared as GitHub does, without case.
  assert.ok(checkManifest(manifest({ repo: 'Owner/runclub' }), release));
  // A stable version also applies in channel beta.
  assert.ok(checkManifest(manifest({ version: '0.2.0' }), { ...release, version: '0.2.0' }));
});

test('the errors read as sentences', () => {
  const primary = pair();
  const bytes = manifestBytes(fields());
  assert.throws(() => verify(bytes, sign(bytes, pair().privateKey), primary.keys), (failure) => /unknown key/.test(render(failure.msg)));
});

// That there are two (primary and backup) is checked by scripts/release.js before it builds.
test('every key the app carries is a valid Ed25519 public key under its id', () => {
  for (const id of Object.keys(KEYS)) {
    const raw = Buffer.from(KEYS[id], 'base64');
    assert.equal(raw.length, 32, id);
    assert.equal(keyId(raw), id);
  }
});
