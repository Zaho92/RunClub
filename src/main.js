// RunClub als Programm: Fenster, Symbol im Infobereich, Start mit Windows.
// Die Runner verwaltet backend.js im selben Prozess; das Fenster zeigt dessen Oberfläche.
// Das Fenster zu schließen beendet nichts – beendet wird über das Symbol im Infobereich oder „Alles beenden“.

const { app, BrowserWindow, Tray, Menu, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { SECOND, MINUTE, HOUR } = require('./units');
const { SLOT } = require('./states');
const { run, lastLine } = require('./run');
const { GH_ENV } = require('./github');
const { createUpdater } = require('./updater');
const { msg, Fault } = require('./messages');
const pkg = require('../package.json');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'build', 'tray.png');
const HIDDEN = process.argv.includes('--hidden');
// Farben und Grenze der Oberfläche, die auch das Fenster braucht; maßgeblich ist ui.html (`--ground`, `--rail`, `--text`,
// `NARROW`).
const GROUND = '#0c1838';
const RAIL = '#091230';
const TEXT = '#c9d2ea';
const NARROW = 760;
const TOOLTIP_INTERVAL = 5 * SECOND; // so oft wird der Hinweis am Symbol im Infobereich aufgefrischt
const UPDATE_FIRST = MINUTE; // nach dem Start, wenn die Runner stehen
const UPDATE_INTERVAL = 6 * HOUR;
// Die Releases liegen im Repo aus package.json (`repository.url`).
const REPO = pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1];

if (!app.requestSingleInstanceLock()) app.exit(0);

app.setAppUserModelId('RunClub');
process.env.RUNCLUB_DATA ||= path.join(app.getPath('userData'), 'data');

let backend = null;
let window = null;
let tray = null;
let updater = null;
let quitting = false; // RunClub baut ab; das Fenster zeigt dabei, was noch fehlt
let exiting = false; // der Abbau ist fertig, das Programm endet
let installer = null; // soll nach dem Abbau eingespielt werden (siehe `installUpdate`)

// Ungepackt startet electron.exe mit dem Projektordner als Argument; das muss auch der Autostart tun.
const loginItem = { path: process.execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] };
const autostart = () => app.getLoginItemSettings(loginItem).openAtLogin;
function setAutostart(on) {
  app.setLoginItemSettings({ ...loginItem, openAtLogin: Boolean(on) });
  refreshTray();
}

// Der Autostart-Eintrag trägt unter Windows den Namen der App (Wert „RunClub“ unter …\Run). Zeigt er noch auf eine
// andere RunClub (den Entwicklungsordner vor der Installation), übernimmt ihn die installierte App: sonst startete mit
// Windows die falsche. Electron nennt einen Eintrag mit fremdem Pfad nicht, deshalb wird die Registry gelesen.
async function adoptAutostart() {
  if (!app.isPackaged || autostart()) return;
  const result = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'RunClub'], { timeout: 10 * SECOND });
  if (result.code === 0 && /RunClub\s+REG_SZ/i.test(result.stdout)) setAutostart(true);
}

// Das Token von `gh` für die Releases, solange das Repo privat ist; ohne Anmeldung wird ohne gefragt.
async function ghToken() {
  const result = await run('gh', ['auth', 'token', '--hostname', 'github.com'], { env: GH_ENV, timeout: 30 * SECOND });
  return result.code === 0 ? lastLine(result.stdout) || null : null;
}

// Spielt das geladene Update ein: nur, wenn kein Runner arbeitet, denn Beenden baut alle ab. Der Installer startet
// erst, wenn der Abbau fertig ist (hooks.onExit), und öffnet RunClub danach wieder.
function installUpdate() {
  const ready = updater.installer();
  if (!ready) throw new Fault('m_noUpdate');
  const working = backend.status().repos.flatMap((repo) => repo.runners).filter((runner) => runner.state === SLOT.WORKING).length;
  if (working) throw new Fault('m_updateBusy', working);
  installer = ready;
  backend.log(msg('m_updating', ready.version));
  quit();
}

function exit() {
  exiting = true;
  if (installer) spawn(installer.file, installer.args, { detached: true, stdio: 'ignore' }).unref();
  app.exit(0);
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
  const url = backend.entry;
  const home = `http://127.0.0.1:${backend.port}/`; // wie die Einstiegsadresse (siehe access.js)
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
  window.on('close', (event) => { if (!exiting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { window = null; });
}

// Menü und Hinweis am Symbol im Infobereich in der Sprache von Windows; die Oberfläche beginnt ebenso (siehe `lang` in
// ui.html), lässt sich dort aber umstellen.
const TRAY_TEXT = {
  de: { open: 'RunClub öffnen', closing: 'Wird beendet …', autostart: 'Mit Windows starten', quit: 'Beenden (Runner stoppen)', stopping: 'RunClub – beendet die Runner …', count: (working, ready) => `RunClub – ${working} arbeiten, ${ready} bereit` },
  en: { open: 'Open RunClub', closing: 'Shutting down …', autostart: 'Start with Windows', quit: 'Quit (stop runners)', stopping: 'RunClub – stopping the runners …', count: (working, ready) => `RunClub – ${working} working, ${ready} ready` },
};
const trayText = () => TRAY_TEXT[app.getLocale().toLowerCase().startsWith('de') ? 'de' : 'en'];

function refreshTray() {
  if (!tray) return;
  const text = trayText();
  if (quitting) { tray.setContextMenu(Menu.buildFromTemplate([{ label: text.open, click: showWindow }, { label: text.closing, enabled: false }])); return; }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: text.open, click: showWindow },
    { label: text.autostart, type: 'checkbox', checked: autostart(), click: (item) => setAutostart(item.checked) },
    { type: 'separator' },
    { label: text.quit, click: quit },
  ]));
}

// Beendet die Seite RunClub („RunClub beenden“ in den Einstellungen), erfährt das Symbol es hier.
function refreshTooltip() {
  if (!tray || quitting) return;
  const status = backend.status();
  if (status.shutdown) { quitting = true; refreshTray(); tray.setToolTip(trayText().stopping); return; }
  const runners = status.repos.flatMap((repo) => repo.runners);
  const count = (state) => runners.filter((runner) => runner.state === state).length;
  tray.setToolTip(trayText().count(count(SLOT.WORKING), count(SLOT.READY)));
}

// Das Fenster zeigt beim Beenden groß, was noch abgebaut wird (`shutdown` in /api/status). Ein offenes Fenster fragt
// sonst erst mit der nächsten Abfrage nach; es wird deshalb gleich angestoßen.
async function quit() {
  if (quitting) return;
  quitting = true;
  refreshTray();
  tray?.setToolTip(trayText().stopping);
  const open = Boolean(window);
  showWindow();
  const done = backend.shutdown(); // endet über hooks.onExit
  if (open) window.webContents.executeJavaScript('refresh()').catch(() => { /* dann mit der nächsten Abfrage */ });
  await done;
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
  backend = require('./backend').start({
    hooks: {
      onExit: exit,
      status: () => ({ app: { autostart: autostart(), update: updater.view() } }),
      actions: {
        'app/autostart': async ({ on }) => setAutostart(on),
        'app/channel': async ({ channel }) => { updater.setChannel(channel); },
        'app/check': async () => { updater.check(); },
        'app/update': async () => installUpdate(),
      },
    },
  });
  updater = createUpdater({
    repo: REPO, current: app.getVersion(), packaged: app.isPackaged, dataDir: process.env.RUNCLUB_DATA, token: ghToken, log: (text) => backend.log(text),
  });
  adoptAutostart();
  setTimeout(() => { updater.check(); setInterval(() => updater.check(), UPDATE_INTERVAL); }, UPDATE_FIRST);

  watchSession();
  tray = new Tray(TRAY_ICON);
  tray.on('click', showWindow);
  refreshTray();
  refreshTooltip();
  setInterval(refreshTooltip, TOOLTIP_INTERVAL);
  if (!HIDDEN) showWindow();
});
