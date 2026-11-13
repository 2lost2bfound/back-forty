// Entry point so that `node --test tests/` works on Node 21+ too: since v21
// the test runner treats a bare directory argument as a module to execute
// (upstream regression, nodejs/node#64555), and Node resolves a directory to
// its index.js. Importing test files here registers them with the root
// harness, so the run still fails on any failing test. Bare `node --test`
// (default discovery) and `node --test tests/*.test.js` also work.
import './rng.test.js';
import './world.test.js';
import './plants.test.js';
import './save.test.js';
import './economy.test.js';
import './heat.test.js';
import './threats.test.js';
