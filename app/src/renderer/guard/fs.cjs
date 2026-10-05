// `fs` as the re-hosted HUD sees it. Reads pass through. A write reaches the disk only when the write policy lets an
// enabled surface write every path it touches (both ends of a rename, the destination of a copy, a link and what it
// points at); otherwise it is refused and logged in the shared guard log. A new folder needs a surface that could write
// a file inside it; a recursive mkdir of a folder that already exists writes nothing, so it is always allowed. Writes
// through a descriptor or a FileHandle pass, because opening one for writing is itself checked.

const real = require("node:fs");
const path = require("node:path");
const { canMakeFolder, canWrite, refuse } = require("../../../compat/src/guard.ts");

const { O_WRONLY, O_RDWR, O_APPEND, O_CREAT, O_TRUNC } = real.constants;

/** Write operations → the indexes of the path arguments they write. */
const TARGETS = {
  writeFile: [0], appendFile: [0], rm: [0], rmdir: [0], unlink: [0], rename: [0, 1], copyFile: [1], cp: [1],
  chmod: [0], lchmod: [0], chown: [0], lchown: [0], truncate: [0], symlink: [1], link: [1], utimes: [0], lutimes: [0],
  mkdtemp: [0], createWriteStream: [0],
};

const isHandle = (a) => typeof a === "number" || (!!a && typeof a === "object" && typeof a.fd === "number");

/** Whether an open() flag argument asks for write access ("w", "a+", "r+", O_WRONLY | O_CREAT …). */
function writeFlags(flags) {
  if (typeof flags === "number") return (flags & (O_WRONLY | O_RDWR | O_APPEND | O_CREAT | O_TRUNC)) !== 0;
  return flags !== undefined && flags !== null && /[wa+]/.test(String(flags));
}

/** "writeFileSync", "promises.writeFile" → "writeFile". */
const baseOf = (name) => name.replace(/^promises\./, "").replace(/Sync$/, "");

/** Every path this call would write, as the policy sees them (mkdtemp's prefix stands for the folder it creates). */
function targets(name, args) {
  const base = baseOf(name);
  const out = [];
  for (const i of TARGETS[base] || [0]) {
    const a = args[i];
    if (isHandle(a)) continue;
    out.push(base === "mkdtemp" ? `${String(a)}XXXXXX` : a);
  }
  // A link may point only at something the same surfaces may write, so it can never carry a later write elsewhere.
  if ((base === "symlink" || base === "link") && typeof args[0] === "string" && typeof args[1] === "string") {
    out.push(path.resolve(path.dirname(args[1]), args[0]));
  }
  return out;
}

function allowed(name, args) { return targets(name, args).every((p) => canWrite(p)); }

function refusal(name, args) { return refuse("write", `fs.${name} ${String(args[0])}${TARGETS[baseOf(name)]?.includes(1) ? ` → ${String(args[1])}` : ""}`); }

function refused(name, args) {
  const err = refusal(name, args);
  const cb = args[args.length - 1];
  if (typeof cb === "function" && !name.endsWith("Sync")) { setTimeout(() => cb(err), 0); return undefined; }
  throw err;
}

const guarded = Object.assign({}, real);

for (const base of Object.keys(TARGETS)) {
  for (const name of base === "createWriteStream" ? [base] : [base, `${base}Sync`]) {
    if (typeof real[name] !== "function") continue;
    guarded[name] = function (...args) { return allowed(name, args) ? real[name](...args) : refused(name, args); };
  }
}

for (const name of ["mkdir", "mkdirSync"]) {
  guarded[name] = function (...args) {
    if (real.existsSync(args[0]) || canMakeFolder(args[0])) return real[name](...args);
    return refused(name, args);
  };
}

guarded.openSync = function (p, flags, mode) {
  if (writeFlags(flags) && !canWrite(p)) throw refuse("write", `fs.openSync ${String(p)} ${String(flags)}`);
  return real.openSync(p, flags, mode);
};

guarded.open = function (p, flags, ...rest) {
  if (typeof flags !== "function" && writeFlags(flags) && !canWrite(p)) return refused("open", [p, flags, ...rest]);
  return real.open(p, flags, ...rest);
};

guarded.promises = Object.assign({}, real.promises);
for (const name of Object.keys(TARGETS)) {
  if (typeof real.promises[name] !== "function") continue;
  guarded.promises[name] = async (...args) => {
    if (!allowed(name, args)) throw refusal(`promises.${name}`, args);
    return real.promises[name](...args);
  };
}
guarded.promises.mkdir = async (...args) => {
  if (!real.existsSync(args[0]) && !canMakeFolder(args[0])) throw refuse("write", `fs.promises.mkdir ${String(args[0])}`);
  return real.promises.mkdir(...args);
};
guarded.promises.open = async (p, flags, mode) => {
  if (writeFlags(flags) && !canWrite(p)) throw refuse("write", `fs.promises.open ${String(p)} ${String(flags)}`);
  return real.promises.open(p, flags, mode);
};

module.exports = guarded;
