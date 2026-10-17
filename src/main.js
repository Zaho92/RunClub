// RunClub as a program: window, tray icon, start with Windows.
// backend.js manages the runners in the same process; the window shows its interface.
// Closing the window ends nothing – quitting goes through the tray icon or “Quit RunClub”.

const { app, BrowserWindow, Tray, Menu, shell, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { SECOND, MINUTE, HOUR } = require('./units');
const { SLOT } = require('./states');
const { run } = require('./run');
const { createUpdater } = require('./updater');
const { msg, Fault } = require('./messages');
const pkg = require('../package.json');

const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const TRAY_ICON = path.join(__dirname, '..', 'build', 'tray.png');
const HIDDEN = process.argv.includes('--hidden');
// Colours and breakpoint of the interface that the window needs too; ui.html is authoritative (`--ground`, `--rail`, `--text`,
// `NARROW`).
const GROUND = '#0c1838';
const RAIL = '#091230';
const TEXT = '#c9d2ea';
const NARROW = 760;
// What the window opens in the browser: GitHub and the guide to installing Docker Desktop (see setup.js).
const EXTERNAL = ['https://github.com/', 'https://docs.docker.com/desktop/'];
const TOOLTIP_INTERVAL = 5 * SECOND; // how often the tray icon's tooltip is refreshed
const UPDATE_FIRST = MINUTE; // after startup, once the runners stand
const UPDATE_INTERVAL = 6 * HOUR;
// The releases live in the repo from package.json (`repository.url`).
const REPO = pkg.repository.url.match(/github\.com\/([^/]+\/[^/.]+)/)[1];

if (!app.requestSingleInstanceLock()) app.exit(0);

app.setAppUserModelId('RunClub');
process.env.RUNCLUB_DATA ||= path.join(app.getPath('userData'), 'data');

let backend = null;
let window = null;
let tray = null;
let updater = null;
let quitting = false; // RunClub is tearing down; meanwhile the window shows what is left
let exiting = false; // teardown is done, the program ends
let installer = null; // to be installed after teardown (see `installUpdate`)

// Unpackaged, electron.exe starts with the project folder as argument; autostart must do the same.
const loginItem = { path: process.execPath, args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'] };
const autostart = () => app.getLoginItemSettings(loginItem).openAtLogin;
function setAutostart(on) {
  app.setLoginItemSettings({ ...loginItem, openAtLogin: Boolean(on) });
  refreshTray();
}

// On Windows the autostart entry carries the app's name (value “RunClub” under …\Run). If it still points to
// another RunClub (the development folder before installing), the installed app takes it over: otherwise the wrong one
// would start with Windows. Electron doesn't report an entry with a foreign path, so the registry is read.
async function adoptAutostart() {
  if (!app.isPackaged || autostart()) return;
  const result = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'RunClub'], { timeout: 10 * SECOND });
  if (result.code === 0 && /RunClub\s+REG_SZ/i.test(result.stdout)) setAutostart(true);
}

// This is how the GitHub sign-in token lies in the data folder: encrypted with the Windows user's key
// (DPAPI). If that isn't available, the sign-in holds only until the program ends (see auth.js).
const secrets = () => (safeStorage.isEncryptionAvailable()
  ? { encrypt: (buffer) => safeStorage.encryptString(buffer.toString('utf8')), decrypt: (buffer) => Buffer.from(safeStorage.decryptString(buffer), 'utf8') }
  : null);

// Installs the downloaded update: only if no runner is working, since quitting tears all of them down. The installer
// starts only once teardown is done (hooks.onExit), and opens RunClub again afterwards.
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

// The Windows buttons above the page's strip: in the ground colour, in a narrow window in the rail's.
const overlay = (narrow) => ({ color: narrow ? RAIL : GROUND, symbolColor: TEXT, height: 32 });

function showWindow() {
  if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); return; }
  window = new BrowserWindow({
    width: 980, height: 860, minWidth: 420, minHeight: 400, title: 'RunClub', icon: ICON, autoHideMenuBar: true, backgroundColor: GROUND,
    // No Windows title bar: the page draws its own strip at the top for dragging (`#bar` in ui.html).
    // Minimize, maximize and close stay Windows buttons, in the app's colours; that way snapping and the
    // keyboard work as usual. The height must match the page's strip.
    titleBarStyle: 'hidden', titleBarOverlay: overlay(false),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  // The entry address carries this program run's key; that way only this window gets the interface.
  const url = backend.entry;
  const home = `http://127.0.0.1:${backend.port}/`; // like the entry address (see access.js)
  window.loadURL(url);
  // The window stays on our own interface; everything else is opened by the browser or not at all.
  window.webContents.on('will-navigate', (event, target) => { if (!target.startsWith(home)) event.preventDefault(); });
  // The service in the same process may start listening a moment after the window loads.
  window.webContents.on('did-fail-load', () => setTimeout(() => { if (window) window.loadURL(url); }, 500));
  window.webContents.setWindowOpenHandler(({ url: target }) => { if (EXTERNAL.some((prefix) => target.startsWith(prefix))) shell.openExternal(target); return { action: 'deny' }; });
  // In a narrow window the strip has the rail's colour; the buttons follow it.
  const matchBar = () => {
    if (!window) return;
    const narrow = window.getContentSize()[0] / window.webContents.getZoomFactor() <= NARROW;
    try { window.setTitleBarOverlay(overlay(narrow)); } catch { /* Windows only */ }
  };
  window.on('resize', matchBar);
  window.webContents.on('did-finish-load', matchBar);
  window.on('close', (event) => { if (!exiting) { event.preventDefault(); window.hide(); } });
  window.on('closed', () => { window = null; });
}

// Menu and tooltip of the tray icon in the language of Windows; the interface starts the same way (see `lang` in
// ui.html), but can be switched there.
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

// If the page quits RunClub (“Quit RunClub” in the settings), the tray icon learns of it here.
function refreshTooltip() {
  if (!tray || quitting) return;
  const status = backend.status();
  if (status.shutdown) { quitting = true; refreshTray(); tray.setToolTip(trayText().stopping); return; }
  const runners = status.repos.flatMap((repo) => repo.runners);
  const count = (state) => runners.filter((runner) => runner.state === state).length;
  tray.setToolTip(trayText().count(count(SLOT.WORKING), count(SLOT.READY)));
}

// While quitting, the window shows in large what is still being torn down (`shutdown` in /api/status). An open window
// would otherwise only ask with its next query; so it is nudged right away.
async function quit() {
  if (quitting) return;
  quitting = true;
  refreshTray();
  tray?.setToolTip(trayText().stopping);
  const open = Boolean(window);
  showWindow();
  const done = backend.shutdown(); // ends via hooks.onExit
  if (open) window.webContents.executeJavaScript('refresh()').catch(() => { /* then with the next query */ });
  await done;
}

// Windows reports the end of the session (sign-out, shutdown) only to windows, and after that only a few seconds remain.
// An invisible window receives the notice, even if the real one was never opened; the backend then
// only removes the free runners from GitHub. Action is taken only on `session-end`: the question
// before it (`query-session-end`) also comes when the shutdown is then cancelled.
function watchSession() {
  const listener = new BrowserWindow({ show: false, width: 1, height: 1, skipTaskbar: true, webPreferences: { sandbox: true } });
  listener.on('session-end', () => backend.release());
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => { /* keeps running in the tray */ });

app.whenReady().then(() => {
  backend = require('./backend').start({
    hooks: {
      onExit: exit,
      secrets: secrets(),
      version: app.getVersion(),
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
    repo: REPO, current: app.getVersion(), packaged: app.isPackaged, dataDir: process.env.RUNCLUB_DATA, token: async () => backend.githubToken(), log: (text) => backend.log(text),
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
