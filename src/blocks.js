// Why a pool can be blocked: otherwise foreign code would run on this machine. A blocked pool pauses, and resuming
// it or routing the jobs to your own runners only works once a check finds the reason gone
// (see remote.js, actions.js). The mark is kept in the pool's settings and survives a restart.
//
//   public         the repo has become public
//   forks          in an organization's repo, workflows from fork pull requests may run (see forks.js)
//   forksUnknown   whether they may run could not be read; the way out is different (wait instead of turning it off)

const BLOCKS = { public: 'pausedPublic', forks: 'pausedForks', forksUnknown: 'pausedForksUnknown' };

// The first reason the pool is blocked for, or null. `own`: the pool's settings.
const blockOf = (own) => Object.keys(BLOCKS).find((kind) => own?.[BLOCKS[kind]]) ?? null;

module.exports = { BLOCKS, blockOf };
