// `child_process` as the re-hosted HUD sees it. A process starts only if the write policy allows it: `node` running one
// of this vault's runtime scripts with an allowed argument list (the HUD's background refreshes always; a surface's
// commands while that surface is enabled), or a program an enabled surface names. Shell strings (exec, execSync) and
// `shell: true` are always refused, because a shell would re-read arguments the policy matched as a list; fork is
// refused too. A refused call is logged and answered by a child that exits with code 1.

const real = require("node:child_process");
const { EventEmitter } = require("node:events");
const { canSpawn, refuse } = require("../../../compat/src/guard.ts");

function allowed(cmd, args, opts) {
  if (opts && opts.shell) return false;
  return canSpawn(cmd, args || [], opts && opts.cwd);
}

/** One line for the guard log. Long arguments keep their tail, where a script path's name is. */
function describe(cmd, args) {
  return [cmd, ...(args || [])].map((s) => { s = String(s); return s.length > 90 ? `…${s.slice(-87)}` : s; }).join(" ").slice(0, 400);
}

function fakeChild(err) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdout.setEncoding = () => child.stdout;
  child.stderr.setEncoding = () => child.stderr;
  child.stdin = { write: () => true, end: () => undefined, on: () => undefined };
  child.pid = undefined;
  child.exitCode = null;
  child.killed = false;
  child.kill = () => false;
  child.unref = () => child;
  child.ref = () => child;
  setTimeout(() => {
    child.stderr.emit("data", Buffer.from(err.message));
    if (child.listenerCount("error") > 0) child.emit("error", err);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    child.emit("close", 1, null);
  }, 0);
  return child;
}

function splitArgs(args, opts, cb) {
  if (typeof args === "function") return { args: [], opts: {}, cb: args };
  if (!Array.isArray(args)) return { args: [], opts: args || {}, cb: typeof opts === "function" ? opts : cb };
  if (typeof opts === "function") return { args, opts: {}, cb: opts };
  return { args, opts: opts || {}, cb };
}

exports.spawn = function (cmd, args, opts) {
  const s = splitArgs(args, opts);
  if (allowed(cmd, s.args, s.opts)) return real.spawn(cmd, s.args, s.opts);
  return fakeChild(refuse("spawn", describe(cmd, s.args)));
};

exports.execFile = function (file, args, opts, cb) {
  const s = splitArgs(args, opts, cb);
  if (allowed(file, s.args, s.opts)) return real.execFile(file, s.args, s.opts, s.cb);
  const err = refuse("spawn", describe(file, s.args));
  if (s.cb) setTimeout(() => s.cb(err, "", err.message), 0);
  return fakeChild(err);
};

exports.exec = function (command, opts, cb) {
  const done = typeof opts === "function" ? opts : cb;
  const err = refuse("spawn", describe(command));
  if (done) setTimeout(() => done(err, "", err.message), 0);
  return fakeChild(err);
};

exports.execFileSync = function (file, args, opts) {
  const s = splitArgs(args, opts);
  if (allowed(file, s.args, s.opts)) return real.execFileSync(file, s.args, s.opts);
  throw refuse("spawn", describe(file, s.args));
};

exports.execSync = function (command) {
  throw refuse("spawn", describe(command));
};

exports.spawnSync = function (cmd, args, opts) {
  const s = splitArgs(args, opts);
  if (allowed(cmd, s.args, s.opts)) return real.spawnSync(cmd, s.args, s.opts);
  const err = refuse("spawn", describe(cmd, s.args));
  return { pid: 0, output: [null, "", err.message], stdout: "", stderr: err.message, status: 1, signal: null, error: err };
};

exports.fork = function (modulePath, args) {
  return fakeChild(refuse("spawn", describe("fork", [modulePath, ...(args || [])])));
};

exports.ChildProcess = real.ChildProcess;

// For the unit tests (tests/unit/spawn-guard.test.ts).
exports.__isAllowed = allowed;
