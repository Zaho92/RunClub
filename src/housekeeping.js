// Occasional upkeep of the pools: whether a repo has become public or allows pull requests from forks (see
// remote.js) and whether orphaned runners are registered at GitHub (see dockerwatch.js). A pair that ends in the middle
// of a job (on shutdown, after a crash) cannot remove its runner: GitHub lists it as busy for a while longer.
// Once it is idle and offline, it is removed here.

const { pairNames } = require('./slots');

//   pools()                 the standing pools
//   mayPoll(key, gap)       may GitHub be asked now? (see github.js)
//   gap                     interval of the upkeep; with a tight limit, look for orphaned runners at most this often per repo
//   watchVisibility(repo), removeRegistrations(repo, options)   from remote.js and dockerwatch.js
function createHousekeeping({ pools, mayPoll, gap, watchVisibility, removeRegistrations }) {
  return function housekeep() {
    for (const pool of pools()) {
      if (pool.removed) continue;
      // Always, even with a tight limit: without a successful check the pool rests (see remote.js). It is two requests.
      watchVisibility(pool.repo);
      // A key of its own: with a tight limit the upkeep would otherwise hardly get past the polling of the runs.
      if (!mayPoll(`housekeeping:${pool.repo}`, gap)) continue;
      removeRegistrations(pool.repo, { keep: () => pairNames(pool), offline: true });
    }
  };
}

module.exports = { createHousekeeping };
