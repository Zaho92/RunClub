// RunClub als Programm: Fenster, Symbol im Infobereich, Start mit Windows.
// Die Runner verwaltet backend.js im selben Prozess; das Fenster zeigt dessen Oberfläche.
// Das Fenster zu schließen beendet nichts – beendet wird über das Symbol im Infobereich oder „Alles beenden“.

const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const path = require('node:path');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'build', 'tray.png');
const HIDDEN = process.argv.includes('--hidden');

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

function showWindow() {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  window = new BrowserWindow({
    width: 980, height: 860, minWidth: 420, minHeight: 400, title: 'RunClub', icon: ICON, autoHideMenuBar: true, backgroundColor: '#15171b',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // Die Einstiegsadresse trägt den Schlüssel dieses Programmlaufs; damit bekommt nur dieses Fenster die Oberfläche.
  const url = backend.ENTRY;
  const home = `http://localhost:${backend.PORT}/`;
  window.loadURL(url);
  // Das Fenster bleibt bei der eigenen Oberfläche; alles andere öffnet der Browser oder gar nichts.
  window.webContents.on('will-navigate', (event, target) => { if (!target.startsWith(home)) event.preventDefault(); });
  // Der Dienst im selben Prozess kann einen Moment später lauschen als das Fenster lädt.
  window.webContents.on('did-fail-load', () => setTimeout(() => { if (window) window.loadURL(url); }, 500));
  window.webContents.setWindowOpenHandler(({ url: target }) => { if (/^https:\/\//.test(target)) shell.openExternal(target); return { action: 'deny' }; });
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

app.on('second-instance', showWindow);
app.on('window-all-closed', () => { /* läuft im Infobereich weiter */ });

app.whenReady().then(() => {
  backend = require('./backend');
  backend.hooks.onExit = () => { quitting = true; app.exit(0); };
  backend.hooks.status = () => ({ app: { autostart: autostart() } });
  backend.hooks.actions['app/autostart'] = async ({ on }) => setAutostart(on);

  tray = new Tray(TRAY_ICON);
  tray.on('click', showWindow);
  refreshTray();
  refreshTooltip();
  setInterval(refreshTooltip, 5000);
  if (!HIDDEN) showWindow();
});
