// Warum ein Pool gesperrt sein kann: Fremder Code liefe sonst auf diesem Rechner. Ein gesperrter Pool pausiert, und
// fortsetzen oder die Jobs auf die eigenen Runner leiten geht erst, wenn eine Prüfung den Grund weggefallen findet
// (siehe remote.js, actions.js). Die Markierung steht in den Einstellungen des Pools und überdauert einen Neustart.
//
//   public         das Repo ist öffentlich geworden
//   forks          in einem Repo einer Organisation dürfen Workflows aus Pull Requests von Forks laufen (siehe forks.js)
//   forksUnknown   ob sie es dürfen, ließ sich nicht lesen; der Ausweg ist ein anderer (abwarten statt abschalten)

const BLOCKS = { public: 'pausedPublic', forks: 'pausedForks', forksUnknown: 'pausedForksUnknown' };

// Der erste Grund, aus dem der Pool gesperrt ist, oder null. `own`: die Einstellungen des Pools.
const blockOf = (own) => Object.keys(BLOCKS).find((kind) => own?.[BLOCKS[kind]]) ?? null;

module.exports = { BLOCKS, blockOf };
