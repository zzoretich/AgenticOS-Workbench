import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { lastStderrLine, runAsk } from "./askSpawner";

test("lastStderrLine skips stack frames and blank lines, returning the last meaningful line", () => {
  assert.equal(
    lastStderrLine("Invalid API key\nNot logged in · Please run /login\n    at foo (x.js:1:1)\n"),
    "Not logged in · Please run /login",
  );
  assert.equal(lastStderrLine(""), "");
  assert.equal(lastStderrLine("    at foo (x.js:1:1)\n    at bar (y.js:2:2)\n"), "");
});

/** A child whose "close" fires (with code null, as a real killed process reports) only when
 *  kill() is called — never on its own. Models the local ask.js process while a user cancel
 *  is in flight. Mirrors claudeAsk.test.ts:23-29. */
function cancelableChild(): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { setImmediate(() => child.emit("close", null)); return true; };
  return child as unknown as ChildProcess;
}

test('a user cancel under ollama reports "cancelled", never "cancelled (timeout)"', async () => {
  const child = cancelableChild();
  const handle = runAsk({ vault: "/tmp/v", question: "q", node: "/usr/bin/node" }, { spawn: () => child });
  setImmediate(() => handle.cancel());
  const r = await handle.result;
  assert.equal(r.ok, false);
  assert.equal(r.error, "cancelled");
  assert.equal(r.exitCode, null);
});
