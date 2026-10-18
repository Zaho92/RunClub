// Asks for a passphrase in the terminal without showing it. Only for the maintainer's scripts (keygen.js, release.js);
// the passphrase never goes into an environment variable or a file.

// Keys typed or pasted ahead of time: what follows an Enter belongs to the next question.
let pending = '';

// Feeds typed text into `state` ({ text, escape }); returns the rest after an Enter, null without one, or 'cancel'.
// Escape sequences (arrow keys and the like) are dropped whole.
function feed(state, chunk) {
  for (let i = 0; i < chunk.length; i += 1) {
    const char = chunk[i];
    if (state.escape === 2) { if (/[@-~]/.test(char)) state.escape = 0; continue; }
    if (state.escape === 1) {
      state.escape = 0;
      if (char === '[' || char === 'O') { state.escape = 2; continue; }
      // A lone Esc: the character after it counts as typed.
    }
    if (char === '\u001b') state.escape = 1;
    else if (char === '\r' || char === '\n') return chunk.slice(i + (char === '\r' && chunk[i + 1] === '\n' ? 2 : 1));
    else if (char === '\u0003') return 'cancel';
    else if (char === '\u0008' || char === '\u007f') state.text = state.text.slice(0, -1);
    else if (char >= ' ') state.text += char;
  }
  return null;
}

function passphrase(question) {
  const input = process.stdin;
  if (!input.isTTY) {
    return Promise.reject(new Error('The passphrase cannot be typed here: this console is not a terminal Node can read from. Run it in Windows Terminal or PowerShell (in Git Bash: winpty npm run release).'));
  }
  return new Promise((resolve, reject) => {
    const state = { text: '', escape: 0 };
    process.stdout.write(question);
    const finish = (rest) => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
      process.stdout.write('\n');
      if (rest === 'cancel') { pending = ''; reject(new Error('Cancelled.')); } else { pending = rest; resolve(state.text); }
    };
    function onData(chunk) {
      const rest = feed(state, chunk);
      if (rest !== null) finish(rest);
    }
    const earlier = pending;
    pending = '';
    const rest = feed(state, earlier);
    if (rest !== null) { process.stdout.write('\n'); if (rest === 'cancel') reject(new Error('Cancelled.')); else { pending = rest; resolve(state.text); } return; }
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}

module.exports = { passphrase, feed };
