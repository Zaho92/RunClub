// Asks for a passphrase in the terminal without showing it. Only for the maintainer's scripts (keygen.js, release.js);
// the passphrase never goes into an environment variable or a file.

function passphrase(question) {
  const input = process.stdin;
  if (!input.isTTY) return Promise.reject(new Error('The passphrase can only be typed in a terminal (run the script there, not piped).'));
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdout.write(question);
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    const done = (failure) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stdout.write('\n');
      if (failure) reject(failure); else resolve(text);
    };
    function onData(chunk) {
      for (const char of chunk) {
        if (char === '\r' || char === '\n') return done();
        if (char === '\u0003') return done(new Error('Cancelled.'));
        if (char === '\u0008' || char === '\u007f') text = text.slice(0, -1);
        else if (char >= ' ') text += char;
      }
    }
    input.on('data', onData);
  });
}

module.exports = { passphrase };
