// Backend messages: a key with values instead of a finished sentence, so the interface shows them in its own
// language. Its tables in ui.html carry the same keys (`m_…`), in German and English; a test checks that. The English
// sentence lives here as well: for the log file, the console and `error.message`.
//
// A message is `{ key, args }`. A value in `args` is
//   text or number    inserted as it is (numbers written the way the language writes them). Texts from outside
//                     (Docker, GitHub, job names) stay text: they cannot be translated.
//   message           translated itself, such as a word like “paused” or a reason
//   list              its values, joined with commas
//   { time }          a time of day (ISO), as hour and minute
// `{0}`, `{1}` … in the sentence stand for the values in order.

const EN = {
  // General
  m_withReason: '{0} – {1}',
  m_exitCode: 'code {0}',
  m_on: 'on', m_off: 'off', m_active: 'active', m_paused: 'paused',

  // Jobs (see slots.js)
  m_jobRun: 'Job “{0}” is running on {1}',
  m_jobEnd: 'Job “{0}” – {1}',
  m_resDone: 'done', m_resFail: 'failed', m_resCancel: 'cancelled',
  m_jobNoResult: 'Job “{0}” ended without a result ({1})',
  m_runnerNoJob: 'Runner ended without a job ({0})',
  m_runnerTimeout: 'stopped after {0} h',
  m_reattach: 'Lost the connection to {0}; still following its output',
  m_unregisterFailed: 'Could not remove the runner from GitHub',
  m_netFailed: 'Could not create the network: {0}',
  m_volumesFailed: 'Could not prepare the volumes: {0}',
  m_daemonFailed: 'Docker daemon does not start: {0}',
  m_toolsFailed: 'Could not copy the runner tools for container jobs: {0}',
  m_daemonNotReady: 'Docker daemon did not become ready{0}',
  m_whyNotReady: ' – {0}',
  m_whyNotReadySeccomp: ' – {0} (the seccomp profile linux/seccomp.json may block a call this Docker version needs)',
  m_whatSlot: 'Slot',
  m_whatPairPrep: 'Preparing a pair',
  m_whatReserve: 'Clearing the reserve',
  m_whatPrep: 'Preparation',

  // Pools (see actions.js)
  m_noPool: 'There is no such pool.',
  m_dockerNotReady: 'Docker is not ready yet; the limits of the Docker VM are still unknown.',
  m_repoName: 'Give the repo as owner/name.',
  m_noAdmin: 'You lack admin rights for this repo; without them no runner can be registered.',
  m_publicRefused: 'The repo is public. Only code you trust may run on your own runners, so pools are only for private repos.',
  m_forksRefused: '{0}. Only code you trust may run on your own runners. {1}',
  m_poolRemoving: 'This pool is being removed. Please wait until that is done.',
  m_poolExists: 'This repo already has a pool.',
  m_nameClash: 'A pool for {0} uses the same name for caches and build service. Two repos with the same name cannot be served at once.',
  m_poolAdded: 'Pool created',
  m_poolSet: '{0}, {1}, cache {2}',
  m_slotsOne: '{0} slot', m_slotsMany: '{0} slots',
  m_poolRetiring: 'Removing pool',
  m_poolRemoved: 'Pool and its caches are removed',
  m_poolRemovedPartly: 'Pool removed, but not everything: {0}',
  m_unknownCache: 'Unknown cache.',
  m_clearing: 'Clearing {0} …',
  m_cachePackages: 'the package cache', m_cacheBuild: 'the build layers', m_cacheImages: 'the learned images', m_cacheAll: 'all caches',
  m_cleared: 'Cleared; the next run fills it again',
  m_routedOn: '{0} set – jobs run on your own runners',
  m_routedOff: '{0} removed – jobs go back to GitHub’s runners',
  m_routingKept: '{0} stays as it is',
  m_variableUnused: 'The workflows do not read {0} – jobs keep going to GitHub’s runners',
  m_variableUnreadable: 'Could not read {0}',
  m_runRerun: 'Run {0} restarted',
  m_runRerunFailed: 'Run {0} restarted (failed jobs only)',
  m_jobRerun: 'Job {0} restarted',
  m_noRun: 'There is no such run.',
  m_noJob: 'There is no such job.',

  // Blocks (see actions.js, blocks.js, forks.js)
  m_forksHow: 'Turn it off under Settings → Actions → General → “Fork pull request workflows in private repositories” (“Run workflows from fork pull requests” off); the organization may enforce it.',
  m_forksUnreadable: 'Could not read whether workflows from forks may run ({0})',
  m_forksAllowed: 'The repo settings let workflows from fork pull requests run',
  m_publicPaused: 'The repo has become public. So that no pull requests from strangers run on this machine, the pool is paused and jobs go back to GitHub’s runners.',
  m_publicLocked: 'The repo is public. The pool can only be used again once it is private.',
  m_publicCleared: 'The repo is private again',
  m_forksPaused: '{0}. So that no code from forks runs on this machine, the pool is paused and jobs go back to GitHub’s runners. {1}',
  m_forksLocked: 'Pull requests from forks could run code on this machine. {0}',
  m_forksCleared: 'Workflows from forks no longer run in this repo',
  m_forksUnknownPaused: '{0}. So that no code from forks runs on this machine, the pool is paused and jobs go back to GitHub’s runners. The next check tries again.',
  m_forksUnknownLocked: 'Could not check whether workflows from forks may run in this repo. The next check tries again.',
  m_forksUnknownCleared: 'Whether workflows from forks may run could be read again',
  m_unblockStill: '{0}; the pool stays blocked: {1}',
  m_unblockFree: '{0}; the pool can be resumed.',
  m_checkBack: 'The check worked again; the pool accepts jobs again.',
  m_unchecked: 'Could not check whether the repo is private and refuses workflows from forks. Until that works, the pool accepts no jobs.',
  m_whatVisibility: 'Repo visibility',

  // Limits (see actions.js, limits.js)
  m_limits: 'runner {0} and {1} cores, Docker {2} and {3} cores',
  m_limitsInherit: 'Back to the limits for all ({0})',
  m_limitsOwn: 'Own limits – {0}',
  m_limitsShared: 'Limits per job: {0}',
  m_limitsNumbers: 'Limits are given as numbers.',
  m_noSuggestion: 'There are not enough measurements for a suggestion yet.',
  m_planApplied: 'Limits taken from the measurements: default runner {0}, Docker {1}',
  m_planAppliedOwn: 'Limits taken from the measurements: default runner {0}, Docker {1}; own limits for {2}',
  m_rebuilding: 'Rebuilding the idle runners with the new limits',

  // GitHub (see github.js, remote.js, minutes.js)
  m_githubPause: 'GitHub asks for a pause; continuing at {0}.',
  m_githubSilent: 'GitHub does not respond.',
  m_githubUnreachable: 'GitHub cannot be reached ({0}).',
  m_quotaSpent: 'The GitHub rate limit is used up; continuing at {0}.',
  m_quotaPaused: 'GitHub asks for a pause (too many requests in a short time). No polling until {0}.',
  m_quotaOut: 'GitHub requests are used up ({0} of {1} left). No polling until {2}; the rest is kept for registering new runners.',
  m_quotaTight: 'GitHub requests are getting tight ({0} of {1} left). Polling less often until {2}.',
  m_quotaFree: 'GitHub requests are available again; polling at the usual pace.',
  m_whatQuota: 'Rate limit',
  m_billingMonth: 'GitHub returned the billing for {0}/{1} instead of {2}/{3}.',
  m_minutesUnreadable: 'Could not read the GitHub minutes quota',

  // Docker (see dockerwatch.js, engine.js, caches.js, seed.js, usage.js)
  m_dockerUnreachableDesktop: 'Docker is not reachable – is Docker Desktop running?',
  m_dockerUnreachable: 'Docker is not reachable – is the daemon running?',
  m_dockerUnreachableHost: 'Docker is not reachable – is the daemon running at {0}?',
  m_dockerUnreachableDistro: 'Docker is not reachable – is the daemon running in the WSL distro {0}?',
  m_dockerUnreachableBoth: 'Docker is not reachable – is the daemon running at {0} in the WSL distro {1}?',
  m_exposedTcp: 'RUNCLUB_DOCKER_HOST points to {0} without TLS (RUNCLUB_DOCKER_CERTS is missing). Any job that reaches this port controls all of Docker.',
  m_exposedDesktop: 'Docker exposes its daemon unprotected on tcp://localhost:2375. Any job reaches it through host.docker.internal and controls all of Docker. Turn off “Expose daemon on tcp://localhost:2375 without TLS” in Docker Desktop under Settings → General.',
  m_dockerGone: 'Docker no longer responds – the Linux runners are waiting.',
  // What the machine lacks (see setup.js)
  m_desktopNotFound: 'Docker Desktop is not installed.',
  m_desktopStarting: 'Starting Docker Desktop …',
  m_desktopStartFailed: 'Docker Desktop could not be started: {0}',
  m_imageRunner: 'The runner image',
  m_imageDaemon: 'The Docker daemon image',
  m_buildFailed: '{0} could not be built: {1}',
  m_rebuildFailed: '{0} could not be rebuilt ({1}); the runners use the existing one.',
  m_imagesDaily: 'Rebuilding the runner and Docker daemon images (daily refresh) …',
  m_imagesBuild: 'Building the runner image (with GitHub’s latest runner) and the Docker daemon image …',
  m_whatImages: 'Runner and Docker daemon images',
  m_whatTemplate: 'Template',
  m_orphansRemoved: 'Removed leftovers after the interruption: containers: {0}, volumes: {1}',
  m_staleRunners: 'Orphaned runners removed from GitHub: {0}',
  m_whatOldRunners: 'Removing old runners',
  m_serviceRetry: 'Trying again to create the build service',
  m_serviceRenew: 'Creating the build service with the new limits',
  m_serviceNetFailed: 'Could not create the network for the build service – {0}',
  m_serviceFailed: 'Build service does not start – {0}',
  m_serviceUnreadable: 'Build service: state after start not readable – {0}',
  m_serviceEnded: 'Build service stops right after starting{0}',
  m_cachesNotRemoved: 'Could not delete the caches – {0}',
  m_seedRefresh: 'Refreshing the template ({0} images) …',
  m_loaderNotReady: 'The loader daemon did not become ready{0}; the template stays as it is.',
  m_seedPullFailed: '{0} does not go into the template – {1}',
  m_seedNotRemoved: 'Could not delete the template – {0}',
  m_vmTight: 'The Docker VM has only {0} GB of {1} GB memory free.',
  m_vmFree: 'The Docker VM has {0} GB memory free again.',
  m_vmUnmeasured: 'The Docker VM’s memory can no longer be measured; the warning is dropped.',

  // Signing in to GitHub (see auth.js)
  m_closing: 'RunClub is shutting down.',
  m_loginRunning: 'A sign-in is already running. Finish or cancel it first.',
  m_alreadyIn: 'You are already signed in as {0}.',
  m_loginFirst: 'Sign in to GitHub first.',
  m_finishLogin: 'Finish or cancel the running sign-in first.',
  m_notIn: 'You are not signed in to GitHub.',
  m_loggedIn: 'Signed in to GitHub as {0}.',
  m_loggedOut: 'Signed out of GitHub ({0}).',
  m_signInLost: 'GitHub no longer accepts the sign-in of {0}; please sign in again.',
  m_githubNoAccount: 'GitHub names no account for the sign-in.',
  m_tokenNotSaved: 'The sign-in could not be saved ({0}); it lasts until this program ends.',
  m_tokenNotRemoved: '{0} could not be deleted ({1}); after a restart the sign-in applies again. The file is stored encrypted in the data folder.',
  m_loginFailed: 'Signing in to GitHub failed: {0}',
  m_loginLate: 'the code was not confirmed in time',
  m_noReason: 'GitHub gave no reason',
  m_whatSignIn: 'Signing in to GitHub',

  // Program (see backend.js, lifecycle.js, settings.js, server.js, main.js)
  m_listening: 'Runner display: {0}',
  m_stopping: 'Stopping the runners …',
  m_stopped: 'Stopped.',
  m_keyNotSaved: 'Could not save the key – {0}',
  m_settingsBroken: 'Could not read {0}; it is created anew. The old file is at {1}.',
  m_bodyIncomplete: 'The request did not arrive completely.',
  m_bodyTooLarge: 'The request is too large.',
  m_bodyNotJson: 'The request is not a valid JSON object.',
  m_noAccess: 'No access. Open RunClub from its icon in the notification area.',
  m_wrongHost: 'wrong host',
  m_unknownCall: 'unknown',
  m_pageStale: 'The page is out of date – please reload.',
  m_noUpdate: 'No update has been downloaded.',
  m_updateBusy: 'A runner is working ({0}). The update can be installed once none is.',
  m_updating: 'RunClub is shutting down and updating to {0}.',

  // Updates (see updater.js)
  m_updateReady: 'RunClub {0} is downloaded and ready to install.',
  m_updateUnreachable: 'GitHub is not reachable: {0}',
  m_updateDenied: 'GitHub does not hand out {0} ({1}).',
  m_updateHttp: 'GitHub answers {0} for {1}.',
  m_updateRedirects: 'Too many redirects while downloading the update.',
  m_updateBroken: 'The installer for {0} is damaged (size or checksum does not match).',
  m_updateUnsigned: 'The update {0} is not signed (runclub-update.json or its signature is missing).',
  m_updateNotTrusted: 'The update {0} is not trusted: {1}',
  m_updateTooLarge: 'The file {1} for {0} is larger than expected.',
  m_updateStalled: 'The download for {0} stalled.',

  // Signature of an update (see signature.js)
  m_sigUnreadable: 'the signature cannot be read',
  m_sigUnknownKey: 'signed with an unknown key ({0})',
  m_sigInvalid: 'the signature does not match',
  m_sigManifestBroken: 'the manifest cannot be read',
  m_sigManifestWrong: 'the manifest does not fit the release ({0})',
  m_updateNoInstaller: 'The installer {1} is missing for {0}.',
  m_unknownChannel: 'Unknown channel: {0}',
};

const KEY = /^m_\w{1,40}$/;

const msg = (key, ...args) => ({ key, args });
const isMsg = (value) => Boolean(value) && typeof value === 'object' && typeof value.key === 'string' && Array.isArray(value.args);

// A value as English text.
function value(item) {
  if (isMsg(item)) return render(item);
  if (Array.isArray(item)) return item.map(value).join(', ');
  if (typeof item === 'number') return item.toLocaleString('en-GB', { maximumFractionDigits: 1 });
  if (item && typeof item === 'object' && 'time' in item) return new Date(item.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return String(item ?? '');
}

// The message as an English sentence; a text stays as it is. An unknown key stands for itself.
function render(message) {
  if (!isMsg(message)) return value(message);
  return (EN[message.key] ?? message.key).replace(/\{(\d)\}/g, (_, at) => value(message.args[at]));
}

// An error that carries its message as a key (`error.msg`); `message` is the English sentence.
class Fault extends Error {
  constructor(key, ...args) {
    const message = msg(key, ...args);
    super(render(message));
    this.msg = message;
  }

  // An error from a finished message; from a text, an ordinary one.
  static of(message) {
    return isMsg(message) ? new Fault(message.key, ...message.args) : new Error(String(message));
  }
}

// What an error reports: its message, otherwise its text (from Node or a program, say).
const reason = (error) => error?.msg ?? String(error?.message ?? error);

// A message that came from outside (from the log file), made safe: only known shapes, texts through `clean`, not
// arbitrarily deep. null if it is none.
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

module.exports = { EN, msg, isMsg, render, Fault, reason, sanitize };
