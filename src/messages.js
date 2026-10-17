// Meldungen des Backends: ein Schlüssel mit Werten statt eines fertigen Satzes, damit die Oberfläche sie in ihrer
// Sprache zeigt. Ihre Tabellen in ui.html führen dieselben Schlüssel (`m_…`), deutsch und englisch; ein Test prüft
// das. Hier steht der deutsche Satz dazu: für die Protokolldatei, die Konsole und `error.message`.
//
// Eine Meldung ist `{ key, args }`. Ein Wert in `args` ist
//   Text oder Zahl    eingesetzt, wie er ist (Zahlen in der Schreibweise der Sprache). Texte von außen (Docker,
//                     GitHub, Jobnamen) bleiben Text: Sie lassen sich nicht übersetzen.
//   Meldung           selbst übersetzt, etwa ein Wort wie „pausiert“ oder ein Grund
//   Liste             ihre Werte, mit Komma verbunden
//   { time }          eine Uhrzeit (ISO), als Stunde und Minute
// `{0}`, `{1}` … im Satz stehen für die Werte der Reihe nach.

const DE = {
  // Allgemein
  m_withReason: '{0} – {1}',
  m_exitCode: 'Code {0}',
  m_on: 'an', m_off: 'aus', m_active: 'aktiv', m_paused: 'pausiert',

  // Jobs (siehe slots.js)
  m_jobRun: 'Job „{0}“ läuft auf {1}',
  m_jobEnd: 'Job „{0}“ – {1}',
  m_resDone: 'fertig', m_resFail: 'Fehler', m_resCancel: 'abgebrochen',
  m_jobNoResult: 'Job „{0}“ endete ohne Ergebnis ({1})',
  m_runnerNoJob: 'Runner endete ohne Job ({0})',
  m_runnerTimeout: 'nach {0} h beendet',
  m_reattach: 'Die Verbindung zu {0} riss ab; es wird weiter mitgelesen',
  m_unregisterFailed: 'Runner ließ sich bei GitHub nicht abmelden',
  m_netFailed: 'Netz lässt sich nicht anlegen: {0}',
  m_volumesFailed: 'Volumes ließen sich nicht vorbereiten: {0}',
  m_daemonFailed: 'Docker-Daemon startet nicht: {0}',
  m_daemonNotReady: 'Docker-Daemon wurde nicht bereit{0}',
  m_whyNotReady: ' – {0}',
  m_whyNotReadySeccomp: ' – {0} (womöglich verbietet das Seccomp-Profil linux/seccomp.json einen Aufruf, den diese Docker-Version braucht)',
  m_whatSlot: 'Platz',
  m_whatPairPrep: 'Vorbereitung eines Paars',
  m_whatReserve: 'Abbau der Reserve',
  m_whatPrep: 'Vorbereitung',

  // Pools (siehe actions.js)
  m_noPool: 'Diesen Pool gibt es nicht.',
  m_dockerNotReady: 'Docker ist noch nicht bereit; die Grenzen der Docker-VM sind noch unbekannt.',
  m_repoName: 'Das Repo wird als besitzer/name angegeben.',
  m_noAdmin: 'Für dieses Repo fehlen dir die Verwaltungsrechte; ohne sie lässt sich kein Runner anmelden.',
  m_publicRefused: 'Das Repo ist öffentlich. Auf den eigenen Runnern darf nur Code laufen, dem du vertraust; Pools gibt es deshalb nur für private Repos.',
  m_forksRefused: '{0}. Auf den eigenen Runnern darf nur Code laufen, dem du vertraust. {1}',
  m_poolRemoving: 'Dieser Pool wird gerade entfernt. Bitte warten, bis das abgeschlossen ist.',
  m_poolExists: 'Für dieses Repo gibt es schon einen Pool.',
  m_nameClash: 'Ein Pool für {0} belegt denselben Namen für Caches und Build-Dienst. Zwei Repos mit gleichem Namen lassen sich nicht zugleich bedienen.',
  m_poolAdded: 'Pool angelegt',
  m_poolSet: '{0}, {1}, Cache {2}',
  m_slotsOne: '{0} Platz', m_slotsMany: '{0} Plätze',
  m_poolRetiring: 'Pool wird entfernt',
  m_poolRemoved: 'Pool und seine Caches sind entfernt',
  m_poolRemovedPartly: 'Pool entfernt, aber nicht alles: {0}',
  m_unknownCache: 'Unbekannter Cache.',
  m_clearing: 'Leere {0} …',
  m_cachePackages: 'den Paket-Cache', m_cacheBuild: 'die Build-Layer', m_cacheImages: 'die gelernten Abbilder', m_cacheAll: 'alle Caches',
  m_cleared: 'Geleert; der nächste Lauf füllt wieder auf',
  m_routedOn: '{0} gesetzt – die Jobs laufen auf den eigenen Runnern',
  m_routedOff: '{0} entfernt – die Jobs gehen wieder an GitHubs Runner',
  m_routingKept: '{0} bleibt, wie es ist',
  m_variableUnused: 'Die Workflows lesen {0} nicht – die Jobs gehen weiter an GitHubs Runner',
  m_variableUnreadable: '{0} ließ sich nicht lesen',
  m_runRerun: 'Lauf {0} erneut gestartet',
  m_runRerunFailed: 'Lauf {0} erneut gestartet (nur die gescheiterten Jobs)',
  m_jobRerun: 'Job {0} erneut gestartet',
  m_noRun: 'Diesen Lauf gibt es nicht.',
  m_noJob: 'Diesen Job gibt es nicht.',

  // Sperren (siehe actions.js, blocks.js, forks.js)
  m_forksHow: 'Abschalten unter Settings → Actions → General → „Fork pull request workflows in private repositories“ („Run workflows from fork pull requests“ aus); die Organisation kann das vorgeben.',
  m_forksUnreadable: 'Ob Workflows aus Forks laufen dürfen, ließ sich nicht lesen ({0})',
  m_forksAllowed: 'In den Einstellungen des Repos dürfen Workflows aus Pull Requests von Forks laufen',
  m_publicPaused: 'Das Repo ist öffentlich geworden. Damit keine fremden Pull Requests auf diesem Rechner laufen, ist der Pool pausiert und die Jobs gehen wieder an GitHubs Runner.',
  m_publicLocked: 'Das Repo ist öffentlich. Der Pool lässt sich erst wieder nutzen, wenn es privat ist.',
  m_publicCleared: 'Das Repo ist wieder privat',
  m_forksPaused: '{0}. Damit kein Code aus Forks auf diesem Rechner läuft, ist der Pool pausiert und die Jobs gehen wieder an GitHubs Runner. {1}',
  m_forksLocked: 'Pull Requests aus Forks könnten auf diesem Rechner Code ausführen. {0}',
  m_forksCleared: 'Workflows aus Forks laufen in diesem Repo nicht mehr',
  m_forksUnknownPaused: '{0}. Damit kein Code aus Forks auf diesem Rechner läuft, ist der Pool pausiert und die Jobs gehen wieder an GitHubs Runner. Die nächste Prüfung versucht es wieder.',
  m_forksUnknownLocked: 'Ob in diesem Repo Workflows aus Forks laufen dürfen, ließ sich nicht prüfen. Die nächste Prüfung versucht es wieder.',
  m_forksUnknownCleared: 'Ob Workflows aus Forks laufen dürfen, ließ sich wieder lesen',
  m_unblockStill: '{0}; der Pool bleibt gesperrt: {1}',
  m_unblockFree: '{0}; der Pool lässt sich fortsetzen.',
  m_checkBack: 'Die Prüfung ist wieder gelungen; der Pool nimmt wieder Jobs an.',
  m_unchecked: 'Ob das Repo privat ist und keine Workflows aus Forks zulässt, ließ sich nicht prüfen. Bis das gelingt, nimmt der Pool keine Jobs an.',
  m_whatVisibility: 'Sichtbarkeit des Repos',

  // Limits (siehe actions.js, limits.js)
  m_limits: 'Runner {0} und {1} Kerne, Docker {2} und {3} Kerne',
  m_limitsInherit: 'Wieder die Limits für alle ({0})',
  m_limitsOwn: 'Eigene Limits – {0}',
  m_limitsShared: 'Limits je Job: {0}',
  m_limitsNumbers: 'Limits werden als Zahlen angegeben.',
  m_noSuggestion: 'Für einen Vorschlag fehlen noch Messwerte.',
  m_planApplied: 'Limits aus den Messwerten übernommen: Standard Runner {0}, Docker {1}',
  m_planAppliedOwn: 'Limits aus den Messwerten übernommen: Standard Runner {0}, Docker {1}; eigene Limits für {2}',
  m_rebuilding: 'Baue die freien Runner mit den neuen Limits auf',

  // GitHub (siehe github.js, remote.js, minutes.js)
  m_githubPause: 'GitHub bittet um eine Pause; weiter um {0}.',
  m_quotaSpent: 'Das Anfragelimit von GitHub ist aufgebraucht; weiter um {0}.',
  m_ghExit: 'gh endete mit {0}',
  m_quotaPaused: 'GitHub bittet um eine Pause (zu viele Anfragen in kurzer Zeit). Bis {0} wird nicht mehr abgefragt.',
  m_quotaOut: 'GitHub-Anfragen sind aufgebraucht ({0} von {1} frei). Bis {2} wird nicht mehr abgefragt; der Rest bleibt für das Anmelden neuer Runner.',
  m_quotaTight: 'GitHub-Anfragen werden knapp ({0} von {1} frei). Bis {2} wird seltener abgefragt.',
  m_quotaFree: 'GitHub-Anfragen sind wieder frei; es wird wieder im gewohnten Takt abgefragt.',
  m_whatQuota: 'Anfragelimit',
  m_billingMonth: 'GitHub lieferte die Abrechnung für {0}/{1} statt für {2}/{3}.',
  m_minutesUnreadable: 'Das Minuten-Kontingent von GitHub ließ sich nicht lesen',

  // Docker (siehe dockerwatch.js, engine.js, caches.js, seed.js, usage.js)
  m_dockerUnreachableDesktop: 'Docker ist nicht erreichbar – läuft Docker Desktop?',
  m_dockerUnreachable: 'Docker ist nicht erreichbar – läuft der Daemon?',
  m_dockerUnreachableHost: 'Docker ist nicht erreichbar – läuft der Daemon unter {0}?',
  m_dockerUnreachableDistro: 'Docker ist nicht erreichbar – läuft der Daemon in der WSL-Distro {0}?',
  m_dockerUnreachableBoth: 'Docker ist nicht erreichbar – läuft der Daemon unter {0} in der WSL-Distro {1}?',
  m_exposedTcp: 'RUNCLUB_DOCKER_HOST zeigt auf {0} ohne TLS (RUNCLUB_DOCKER_CERTS fehlt). Jeder Job, der diesen Port erreicht, steuert damit ganz Docker.',
  m_exposedDesktop: 'Docker gibt seinen Daemon ohne Schutz auf tcp://localhost:2375 frei. Jeder Job erreicht ihn über host.docker.internal und steuert damit ganz Docker. In Docker Desktop unter Settings → General „Expose daemon on tcp://localhost:2375 without TLS“ ausschalten.',
  m_dockerGone: 'Docker antwortet nicht mehr – die Linux-Runner warten.',
  // Was dem Rechner fehlt (siehe setup.js)
  m_desktopNotFound: 'Docker Desktop ist nicht installiert.',
  m_desktopStarting: 'Starte Docker Desktop …',
  m_desktopStartFailed: 'Docker Desktop ließ sich nicht starten: {0}',
  m_imageRunner: 'Das Runner-Abbild',
  m_imageDaemon: 'Das Abbild des Docker-Daemons',
  m_buildFailed: '{0} ließ sich nicht bauen: {1}',
  m_rebuildFailed: '{0} ließ sich nicht neu bauen ({1}); die Runner nutzen das vorhandene.',
  m_imagesDaily: 'Baue die Abbilder von Runner und Docker-Daemon neu (tägliche Auffrischung) …',
  m_imagesBuild: 'Baue die Abbilder von Runner (mit dem neuesten Runner von GitHub) und Docker-Daemon …',
  m_whatImages: 'Abbilder von Runner und Docker-Daemon',
  m_orphansRemoved: 'Reste nach der Unterbrechung entfernt: {0} Container, {1} Volumes',
  m_staleRunners: '{0} verwaiste Runner bei GitHub abgemeldet',
  m_whatOldRunners: 'Abmelden alter Runner',
  m_serviceRetry: 'Versuche erneut, den Build-Dienst anzulegen',
  m_serviceRenew: 'Lege den Build-Dienst mit den neuen Limits an',
  m_serviceNetFailed: 'Netz für den Build-Dienst lässt sich nicht anlegen – {0}',
  m_serviceFailed: 'Build-Dienst startet nicht – {0}',
  m_serviceUnreadable: 'Build-Dienst: Zustand nach dem Start nicht lesbar – {0}',
  m_serviceEnded: 'Build-Dienst endet gleich nach dem Start{0}',
  m_cachesNotRemoved: 'Caches ließen sich nicht löschen – {0}',
  m_seedRefresh: 'Frische die Vorlage auf ({0} Abbilder) …',
  m_loaderNotReady: 'Der Lade-Daemon wurde nicht bereit{0}; die Vorlage bleibt unverändert.',
  m_seedPullFailed: '{0} kommt nicht in die Vorlage – {1}',
  m_seedNotRemoved: 'Die Vorlage ließ sich nicht löschen – {0}',
  m_vmTight: 'Die Docker-VM hat nur noch {0} GB von {1} GB Arbeitsspeicher frei.',
  m_vmFree: 'Die Docker-VM hat wieder {0} GB Arbeitsspeicher frei.',
  m_vmUnmeasured: 'Die Belegung der Docker-VM lässt sich nicht mehr messen; die Warnung entfällt.',

  // Anmeldung bei GitHub (siehe auth.js)
  m_closing: 'RunClub wird gerade beendet.',
  m_leaving: 'Es wird gerade abgemeldet. Bitte warten, bis das abgeschlossen ist.',
  m_loginRunning: 'Es läuft schon eine Anmeldung. Erst diese abschließen oder abbrechen.',
  m_ghMissing: 'Das Programm gh ist nicht installiert.',
  m_alreadyIn: 'Du bist schon als {0} angemeldet.',
  m_authUnknown: 'Der Stand der Anmeldung ließ sich noch nicht lesen. Bitte gleich noch einmal versuchen.',
  m_loginFirst: 'Erst bei GitHub anmelden.',
  m_scopeNotMissing: 'Dieses Recht fehlt nicht oder lässt sich hier nicht ergänzen.',
  m_noScopeMissing: 'Der Anmeldung fehlt kein Recht.',
  m_leavingAlready: 'Es wird schon abgemeldet.',
  m_finishLogin: 'Erst die laufende Anmeldung abschließen oder abbrechen.',
  m_notIn: 'Du bist nicht bei GitHub angemeldet.',
  m_loginUnknown: 'Das Konto lässt sich nicht bestimmen. Bitte im Terminal abmelden: gh auth logout',
  m_ghSilent: 'gh antwortet nicht.',
  m_loggedIn: 'Bei GitHub angemeldet als {0}.',
  m_loggedOut: 'Bei GitHub abgemeldet ({0}).',
  m_loggedOutSwitch: 'Bei GitHub abgemeldet ({0}). gh nutzt jetzt das Konto {1}.',

  // Programm (siehe backend.js, lifecycle.js, settings.js, server.js, main.js)
  m_listening: 'Runner-Anzeige: {0}',
  m_stopping: 'Beende die Runner …',
  m_stopped: 'Beendet.',
  m_keyNotSaved: 'Der Schlüssel ließ sich nicht ablegen – {0}',
  m_settingsBroken: '{0} ließ sich nicht lesen und wird neu angelegt. Die alte Datei liegt unter {1}.',
  m_bodyIncomplete: 'Der Aufruf kam nicht vollständig an.',
  m_bodyTooLarge: 'Der Aufruf ist zu groß.',
  m_bodyNotJson: 'Der Aufruf ist kein gültiges JSON-Objekt.',
  m_noAccess: 'Kein Zugriff. RunClub über das Symbol im Infobereich öffnen.',
  m_wrongHost: 'falscher Host',
  m_unknownCall: 'unbekannt',
  m_pageStale: 'Die Seite ist veraltet – bitte neu laden.',
  m_noUpdate: 'Es ist kein Update geladen.',
  m_updateBusy: 'Gerade arbeitet ein Runner ({0}). Das Update lässt sich einspielen, sobald keiner mehr arbeitet.',
  m_updating: 'RunClub wird beendet und auf {0} aktualisiert.',

  // Updates (siehe updater.js)
  m_updateReady: 'RunClub {0} ist geladen und kann eingespielt werden.',
  m_updateUnreachable: 'GitHub ist nicht erreichbar: {0}',
  m_updatePrivate: 'GitHub gibt {0} nicht heraus ({1}).',
  m_updateHttp: 'GitHub antwortet mit {0} auf {1}.',
  m_updateRedirects: 'Zu viele Weiterleitungen beim Laden des Updates.',
  m_updateBroken: 'Der Installer für {0} ist beschädigt (Prüfsumme stimmt nicht).',
  m_updateNoYml: 'Zu {0} fehlt die Angabe des Installers (latest.yml).',
  m_updateYmlIncomplete: 'Die Angabe des Installers zu {0} ist unvollständig.',
  m_updateNoInstaller: 'Zu {0} fehlt der Installer {1}.',
  m_unknownChannel: 'Unbekannter Kanal: {0}',
};

const KEY = /^m_\w{1,40}$/;

const msg = (key, ...args) => ({ key, args });
const isMsg = (value) => Boolean(value) && typeof value === 'object' && typeof value.key === 'string' && Array.isArray(value.args);

// Ein Wert als deutscher Text.
function value(item) {
  if (isMsg(item)) return render(item);
  if (Array.isArray(item)) return item.map(value).join(', ');
  if (typeof item === 'number') return item.toLocaleString('de-DE', { maximumFractionDigits: 1 });
  if (item && typeof item === 'object' && 'time' in item) return new Date(item.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return String(item ?? '');
}

// Die Meldung als deutscher Satz; ein Text bleibt, wie er ist. Ein unbekannter Schlüssel steht selbst da.
function render(message) {
  if (!isMsg(message)) return value(message);
  return (DE[message.key] ?? message.key).replace(/\{(\d)\}/g, (_, at) => value(message.args[at]));
}

// Ein Fehler, der seine Meldung als Schlüssel trägt (`error.msg`); `message` ist der deutsche Satz.
class Fault extends Error {
  constructor(key, ...args) {
    const message = msg(key, ...args);
    super(render(message));
    this.msg = message;
  }

  // Ein Fehler aus einer fertigen Meldung; aus einem Text ein gewöhnlicher.
  static of(message) {
    return isMsg(message) ? new Fault(message.key, ...message.args) : new Error(String(message));
  }
}

// Was ein Fehler meldet: seine Meldung, sonst sein Text (etwa von Node oder einem Programm).
const reason = (error) => error?.msg ?? String(error?.message ?? error);

// Eine Meldung, die von außen kam (aus der Datei des Protokolls), in sichere Form: nur bekannte Formen, Texte durch
// `clean`, nicht beliebig tief. null, wenn sie keine ist.
function sanitize(message, clean, depth = 0) {
  if (!isMsg(message) || !KEY.test(message.key) || depth > 3) return null;
  const item = (entry) => {
    if (isMsg(entry)) return sanitize(entry, clean, depth + 1) ?? '';
    if (Array.isArray(entry)) return entry.slice(0, 50).map((inner) => (Array.isArray(inner) ? '' : item(inner)));
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : 0;
    if (entry && typeof entry === 'object' && 'time' in entry) return { time: Number.isNaN(new Date(entry.time).getTime()) ? new Date(0).toISOString() : new Date(entry.time).toISOString() };
    return clean(entry ?? '');
  };
  return { key: message.key, args: message.args.slice(0, 10).map(item) };
}

module.exports = { DE, msg, isMsg, render, Fault, reason, sanitize };
