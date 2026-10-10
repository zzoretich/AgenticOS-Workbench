// AOS_E2E_STRAGGLER=1 forces the race between a scan the app leaves running and the next spec file's restoreFixture()
// (CI run 38055402066: theme.spec.ts failed in restoreFixture with ENOTEMPTY, rmdir '<fixture>/vault/brain').
//
// The app starts `scan-vault.js --quiet` detached (main.ts runBrainScript; terminalLauncher.ts refreshSpaces after a new
// workspace or Scratch) and does not stop it on quit (ProcService.killAttached spares detached children), so a scan can
// outlive the app it came from. launchApp puts this file in main's NODE_OPTIONS, so every node the app spawns loads it;
// it acts only in brain/scripts/scan-vault.js. There, the scan's first write that would create a folder under
// vault/brain (lib/fsx.js writeAtomic: mkdir -p, a temp file, a rename), made while the app is up, waits until the app
// has quit and the next restoreFixture() has removed brain/_index. Then it repeats that mkdir -p while rmSync is still
// emptying the vault, so the rmdir of brain (or of the vault) fails with ENOTEMPTY, as a slow scan's writes did on CI by
// chance, and the scan stops. Nothing here waits longer than 10 s.
//
// With close() waiting for what the app started (harness.ts, the app's processes), no restore comes while the scan is
// held: it gives up at its 10 s and finishes, or close() kills it, and the run passes. Without that, theme.spec.ts fails
// in its restoreFixture(). harness.spec.ts pins the same promise on every run, with stand-ins instead of the scan.
//
//   AOS_E2E_STRAGGLER=1 npx playwright test tests/e2e/term-writes.spec.ts tests/e2e/theme.spec.ts
'use strict';

if (/[\\/]brain[\\/]scripts[\\/]scan-vault\.js$/.test(process.argv[1] || '')) {
  const fs = require('fs');
  const path = require('path');
  const brain = path.resolve(process.argv[1], '..', '..');
  const index = path.join(brain, '_index');
  const app = process.ppid;
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const mkdirSync = fs.mkdirSync;
  let held = false;
  fs.mkdirSync = function (p, opts, ...rest) {
    if (!held && opts && opts.recursive && path.resolve(String(p)).startsWith(brain + path.sep)) {
      held = true;
      // Only a scan that writes while the app is still up is held: one that gets there later (a second scan, queued
      // behind this one's ledger lock) goes on as usual instead of waiting for the next run's restore.
      if (!alive(app)) return mkdirSync.call(this, p, opts, ...rest);
      const until = Date.now() + 10_000;
      while (alive(app) && Date.now() < until) sleep(5);
      while (fs.existsSync(index) && Date.now() < until) sleep(0.01);
      if (!fs.existsSync(index)) {
        // The delete has passed brain/_index. Repeat this mkdir -p for a quarter second (the rest of the delete takes a
        // few ms) or until the vault is back, so the overlap does not hang on how fast rmSync empties the rest (a slow
        // scan's write phase issues dozens of these), then stop: a scan going on over a half-deleted vault would only
        // spill into the next run.
        for (const stop = Date.now() + 250; Date.now() < stop && !fs.existsSync(path.join(index, 'snapshot.json'));) {
          try { mkdirSync.call(this, p, opts, ...rest); } catch { /* a parent went in between */ }
        }
        process.exit(0);
      }
    }
    return mkdirSync.call(this, p, opts, ...rest);
  };
}
