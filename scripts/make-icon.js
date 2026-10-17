// Draws the app's icon and stores it as PNG (window, tray) and ICO (shortcut) in build/.
// Usage:  npm run icon

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'build');
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#24304f"/><stop offset="1" stop-color="#0e1422"/></linearGradient></defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#g)"/>
  <rect x="84" y="140" width="344" height="232" rx="116" fill="none" stroke="#ff7a45" stroke-width="34"/>
  <rect x="140" y="196" width="232" height="120" rx="60" fill="none" stroke="#f3f5f9" stroke-width="26"/>
  <circle cx="256" cy="140" r="30" fill="#3ecf7c" stroke="#0e1422" stroke-width="10"/>
</svg>`;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 512, height: 512, frame: false, transparent: true, webPreferences: { offscreen: true } });
  await window.loadURL(`data:text/html,${encodeURIComponent(`<body style="margin:0;background:transparent">${SVG}</body>`)}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const image = (await window.webContents.capturePage()).resize({ width: 512, height: 512, quality: 'best' });
  const png = (size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'icon.png'), image.toPNG());
  fs.writeFileSync(path.join(OUT, 'tray.png'), png(32));

  // ICO with a single PNG image (256 px): header, one directory entry, then the PNG data.
  const data = png(256);
  const head = Buffer.alloc(22);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  head.writeUInt16LE(1, 10); // colour planes (width and height 0 = 256)
  head.writeUInt16LE(32, 12); // bits per pixel
  head.writeUInt32LE(data.length, 14);
  head.writeUInt32LE(22, 18);
  fs.writeFileSync(path.join(OUT, 'icon.ico'), Buffer.concat([head, data]));
  app.exit(0);
});
