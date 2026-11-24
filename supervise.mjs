// Keep the server running.
//
// Node's own bundled HTTP client threw an assertion from inside a TLS socket
// teardown — `assert(!this.paused)` in undici's parser — and took the process
// with it. Not this repo's code, nothing to fix here, and rare: once in
// sixty-five runs. But nothing restarted it, so the clipper was simply dead
// until somebody looked. A thing meant to run unattended has to survive the
// crashes it cannot prevent.
//
//   node supervise.mjs        (or: npm run supervise)
//
// Everything in the environment is passed through, so this is also where the
// settings live if they are not in .env.

import { spawn } from 'node:child_process';

// SUPERVISE_TARGET exists so the restarting can be tested against a script
// that fails on purpose. Nothing else sets it.
const SERVER =
  process.env.SUPERVISE_TARGET ||
  new URL('./src/server.js', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

// Back off when it fails immediately, so a server that cannot start at all —
// a port already taken, a syntax error — does not spin.
const FIRST_DELAY = 1000;
const MAX_DELAY = 60_000;
// Longer than any plausible crash loop: if it ran this long, whatever went
// wrong was not a start-up problem, so start the backoff over.
const HEALTHY_MS = 120_000;

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (message) => console.log(`[${stamp()}] supervisor: ${message}`);

let delay = FIRST_DELAY;
let child = null;
let stopping = false;

function start() {
  const startedAt = Date.now();
  child = spawn(process.execPath, [SERVER], { stdio: 'inherit', env: process.env });

  child.on('error', (err) => say(`could not start node: ${err.message}`));

  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;

    const ranFor = Date.now() - startedAt;
    if (ranFor >= HEALTHY_MS) delay = FIRST_DELAY;

    // A clean exit is a decision, not a failure. The lock refusing a second
    // copy exits 0, and restarting into that forever would be a busy loop
    // that never says why.
    if (code === 0 && !signal) {
      say('server exited cleanly; not restarting');
      process.exit(0);
    }

    const why = signal ? `signal ${signal}` : `code ${code}`;
    say(`server stopped (${why}) after ${Math.round(ranFor / 1000)}s — restarting in ${Math.round(delay / 1000)}s`);
    // Emphatically NOT unref'd: this timer is the only thing holding the
    // process open between the child dying and the next one starting. With
    // unref it printed "restarting in 1s" and then exited, which is a
    // supervisor that supervises until the first thing goes wrong.
    setTimeout(start, delay);
    delay = Math.min(delay * 2, MAX_DELAY);
  });
}

// Ctrl-C should stop both, not orphan the server and leave its lock behind.
const stop = (signal) => () => {
  stopping = true;
  say(`stopping on ${signal}`);
  if (child) child.kill(signal);
  setTimeout(() => process.exit(0), 2000).unref?.();
};
process.on('SIGINT', stop('SIGINT'));
process.on('SIGTERM', stop('SIGTERM'));

say('starting the server, and restarting it if it stops');
start();
