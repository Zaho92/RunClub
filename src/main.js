// RunClub als Programm: Fenster, Symbol im Infobereich, Start mit Windows.
// Die Runner verwaltet backend.js im selben Prozess; das Fenster zeigt dessen Oberfläche.
// Das Fenster zu schließen beendet nichts – beendet wird über das Symbol im Infobereich oder „Alles beenden“.

const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const path = require('node:path');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'build', 'tray.png');
const HIDDEN = process.argv.includes('--hidden');
// Farben und Grenze der Oberfläche, die auch das Fenster braucht; maßgeblich ist ui.html (`--ground`, `--rail`, `--text`,
// `NARROW`).
const GROUND = '#0c1838';
const RAIL = '#091230';
const TEXT = '#c9d2ea';
const NARROW = 760;

if (!app.requestSingleInstanceLock()) app.exit(0);

app.setAppUserModelId('RunClub');
process.env.RUNCLUB_DATA ||= path.join(app.getPath('userData'), 'data');

let backend = null;
let window = null;
let tray = null;
let quitting = false;

// Ungepackt startet electron.exe mit dem Projektordner als Argument; das muss auch der Autostart tun.
const loginItem = { path: process.execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] };
const autostart = () => app.getLoginItemSettings(loginItem).openAtLogin;
function setAutostart(on) {
  app.setLoginItemSettings({ ...loginItem, openAtLogin: Boolean(on) });
  refreshTray();
}

// Die Knöpfe von Windows über dem Streifen der Seite: in der Farbe des Grundes, im schmalen Fenster der Leiste.
const overlay = (narrow) => ({ color: narrow ? RAIL : GROUND, symbolColor: TEXT, height: 32 });

function showWindow() {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  window = new BrowserWindow({
    width: 980, height: 860, minWidth: 420, minHeight: 400, title: 'RunClub', icon: ICON, autoHideMenuBar: true, backgroundColor: GROUND,
    // Keine Titelleiste von Windows: Die Seite zeichnet oben einen eigenen Streifen zum Ziehen (`#bar` in ui.html).
    // Minimieren, Maximieren und Schließen bleiben die Knöpfe von Windows, in den Farben der App; so funktionieren
    // Andocken und Tastatur wie gewohnt. Die Höhe muss zum Streifen der Seite passen.
    titleBarStyle: 'hidden', titleBarOverlay: overlay(false),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // Die Einstiegsadresse trägt den Schlüssel dieses Programmlaufs; damit bekommt nur dieses Fenster die Oberfläche.
  const url = backend.ENTRY;
  const home = `http://127.0.0.1:${backend.PORT}/`; // wie die Einstiegsadresse (siehe access.js)
  window.loadURL(url);
  // Das Fenster bleibt bei der eigenen Oberfläche; alles andere öffnet der Browser oder gar nichts.
  window.webContents.on('will-navigate', (event, target) => { if (!target.startsWith(home)) event.preventDefault(); });
  // Der Dienst im selben Prozess kann einen Moment später lauschen als das Fenster lädt.
  window.webContents.on('did-fail-load', () => setTimeout(() => { if (window) window.loadURL(url); }, 500));
  window.webContents.setWindowOpenHandler(({ url: target }) => { if (target.startsWith('https://github.com/')) shell.openExternal(target); return { action: 'deny' }; });
  // Im schmalen Fenster trägt der Streifen die Farbe der Leiste; die Knöpfe folgen ihm.
  const matchBar = () => {
    if (!window) return;
    const narrow = window.getContentSize()[0] / window.webContents.getZoomFactor() <= NARROW;
    try { window.setTitleBarOverlay(overlay(narrow)); } catch { /* nur unter Windows */ }
  };
  window.on('resize', matchBar);
  window.webContents.on('did-finish-load', matchBar);
  window.on('close', (event) => { if (!quitting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { window = null; });
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'RunClub öffnen', click: showWindow },
    { label: 'Mit Windows starten', type: 'checkbox', checked: autostart(), click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: 'Beenden (Runner stoppen)', click: quit },
  ]));
}

function refreshTooltip() {
  if (!tray || quitting) return;
  const runners = backend.status().repos.flatMap((repo) => repo.runners);
  const count = (state) => runners.filter((runner) => runner.state.startsWith(state)).length;
  tray.setToolTip(`RunClub – ${count('arbeitet')} arbeiten, ${count('bereit')} bereit`);
}

async function quit() {
  if (quitting) return;
  quitting = true;
  tray?.setToolTip('RunClub – beendet die Runner …');
  await backend.shutdown(); // endet über hooks.onExit
}

// Das Ende der Sitzung (Abmelden, Herunterfahren) meldet Windows nur an Fenster, und danach bleiben wenige Sekunden.
// Ein unsichtbares Fenster nimmt die Meldung entgegen, auch wenn das eigentliche nie geöffnet wurde; das Backend meldet
// dann nur noch die freien Runner bei GitHub ab. Gehandelt wird erst bei `session-end`: Die Frage
// davor (`query-session-end`) kommt auch, wenn das Herunterfahren dann abgebrochen wird.
function watchSession() {
  const listener = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, webPreferences: { sandbox: true } });
  listener.on('session-end', () => backend.release());
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => { /* läuft im Infobereich weiter */ });

app.whenReady().then(() => {
  backend = require('./backend');
  backend.hooks.onExit = () => { quitting = true; app.exit(0); };
  backend.hooks.status = () => ({ app: { autostart: autostart() } });
  backend.hooks.actions['app/autostart'] = async ({ on }) => setAutostart(on);

  watchSession();
  tray = new Tray(TRAY_ICON);
  tray.on('click', showWindow);
  refreshTray();
  refreshTooltip();
  setInterval(refreshTooltip, 5000);
  if (!HIDDEN) showWindow();
});
