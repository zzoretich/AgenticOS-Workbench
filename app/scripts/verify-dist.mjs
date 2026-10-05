// Phase 3's exit criterion for a build (PLAN.md §7): the app and the DMG in dist/ are signed with a Developer ID under
// the hardened runtime, notarized and stapled, carry exactly the entitlements and fuses electron-builder.yml asks for,
// and ship nothing they should not (source maps, other platforms' prebuilds, a home folder's path).
//
//   node scripts/verify-dist.mjs [--notarize-dmg] [--app-only]
//
// electron-builder notarizes and staples only the app. --notarize-dmg first sends the DMG to Apple's notary service
// and staples its ticket, with the notarytool keychain profile named in APPLE_KEYCHAIN_PROFILE. --app-only skips the
// DMG (a `--dir` build).

import { extractFile, listPackage } from "@electron/asar";
import { FuseV1Options, getCurrentFuseWire } from "@electron/fuses";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
const APP_ID = "com.zzoretich.agenticos-workbench";
const NAME = "AgenticOS Workbench";
const APP = path.join(repo, "dist", "mac-arm64", `${NAME}.app`);
const DMG = path.join(repo, "dist", `AgenticOS-Workbench-${pkg.version}-arm64.dmg`);
const RES = path.join(APP, "Contents", "Resources");
const PTY = path.join(RES, "app.asar.unpacked", "node_modules", "node-pty", "prebuilds", "darwin-arm64");
const ENTITLEMENTS = ["com.apple.security.automation.apple-events", "com.apple.security.cs.allow-jit"];
const ON = 49;
const OFF = 48;
const FUSES = {
  RunAsNode: OFF,
  EnableCookieEncryption: ON,
  EnableNodeOptionsEnvironmentVariable: OFF,
  EnableNodeCliInspectArguments: OFF,
  EnableEmbeddedAsarIntegrityValidation: ON,
  OnlyLoadAppFromAsar: ON,
  LoadBrowserProcessSpecificV8Snapshot: OFF,
  GrantFileProtocolExtraPrivileges: OFF,
};
// Electron 44's ninth fuse, which @electron/fuses 1.8 has no name for: WasmTrapHandlers, left at its default (on).
const WASM_TRAP_HANDLERS = 8;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`);
};
const run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout ?? "", out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
/** A property list (a file, or XML text) as JSON. */
const plist = (file, text) => JSON.parse(run("plutil", ["-convert", "json", "-o", "-", text === undefined ? file : "-"], text).stdout);
const firstLine = (s) => s.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
/** The signing facts codesign reports for one file or bundle. */
function signature(target) {
  const out = run("codesign", ["-dv", "--verbose=4", target]).out;
  return {
    identifier: /^Identifier=(.*)$/m.exec(out)?.[1],
    team: /^TeamIdentifier=(.*)$/m.exec(out)?.[1],
    runtime: /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/.test(out),
    developerId: /^Authority=Developer ID Application: /m.test(out),
    timestamp: /^Timestamp=/m.test(out),
    cdhash: /^CDHash=(.*)$/m.exec(out)?.[1],
  };
}

if (!fs.existsSync(APP)) { console.error(`no app at ${APP}: run \`npm run dist\``); process.exit(2); }

// ── notarize the DMG (optional) ──────────────────────────────────────

if (argv.includes("--notarize-dmg")) {
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!profile) { console.error("--notarize-dmg needs APPLE_KEYCHAIN_PROFILE (a notarytool keychain profile)"); process.exit(2); }
  console.log(`notarizing ${path.basename(DMG)} (this waits for Apple)…`);
  const sub = run("xcrun", ["notarytool", "submit", DMG, "--keychain-profile", profile, "--wait"]);
  // notarytool prints "status: In Progress" while it waits; the last status line is Apple's verdict.
  const status = [...sub.out.matchAll(/status: ([A-Za-z ]+)/g)].pop()?.[1]?.trim();
  check("Apple accepts the DMG", sub.code === 0 && status === "Accepted", status ?? firstLine(sub.out));
  const staple = run("xcrun", ["stapler", "staple", DMG]);
  check("its ticket is stapled", staple.code === 0, firstLine(staple.out));
}

// ── the app's identity ───────────────────────────────────────────────

const info = plist(path.join(APP, "Contents", "Info.plist"));
check("bundle id", info.CFBundleIdentifier === APP_ID, info.CFBundleIdentifier);
check("name", info.CFBundleName === NAME && info.CFBundleDisplayName === NAME, info.CFBundleName);
check("version", info.CFBundleShortVersionString === pkg.version, info.CFBundleShortVersionString);
const schemes = (info.CFBundleURLTypes ?? []).flatMap((t) => t.CFBundleURLSchemes ?? []);
check("claims agenticos://", schemes.length === 1 && schemes[0] === "agenticos", schemes.join(", "));

// ── signature, entitlements, fuses ───────────────────────────────────

const strict = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", APP]);
check("codesign --verify --deep --strict", strict.code === 0, firstLine(strict.out));
const sig = signature(APP);
check("signed with a Developer ID, hardened runtime, secure timestamp", sig.developerId && sig.runtime && sig.timestamp && sig.team && sig.team !== "not set", `team ${sig.team}`);
const ents = plist(null, run("codesign", ["-d", "--entitlements", "-", "--xml", APP]).stdout);
const entKeys = Object.keys(ents).sort();
check("entitlements are exactly allow-jit and apple-events", JSON.stringify(entKeys) === JSON.stringify(ENTITLEMENTS) && entKeys.every((k) => ents[k] === true), entKeys.join(", "));
for (const bin of ["pty.node", "spawn-helper"]) {
  const s = signature(path.join(PTY, bin));
  check(`node-pty's ${bin} is signed by the same team, hardened`, s.team === sig.team && s.runtime, `${s.identifier} team ${s.team}`);
}
check("spawn-helper is executable", (fs.statSync(path.join(PTY, "spawn-helper")).mode & 0o111) === 0o111);

const wire = await getCurrentFuseWire(APP);
for (const [name, want] of Object.entries(FUSES)) {
  const got = wire[FuseV1Options[name]];
  check(`fuse ${name} ${want === ON ? "on" : "off"}`, got === want, got === ON ? "on" : got === OFF ? "off" : String(got));
}
check("fuse WasmTrapHandlers on (Electron's default)", wire[WASM_TRAP_HANDLERS] === ON);

// ── what the archive holds ───────────────────────────────────────────

const asar = path.join(RES, "app.asar");
const files = listPackage(asar, { isPack: false }).map((f) => f.replace(/\\/g, "/"));
const outFiles = files.filter((f) => f.startsWith("/out/") && /\.[a-z]+$/.test(f)).sort();
const expectedOut = ["/out/main/index.js", "/out/renderer/base.css", "/out/renderer/host.css", "/out/renderer/hud.css", "/out/renderer/hud.js", "/out/renderer/index.html"];
check("out/ holds the app and nothing else", JSON.stringify(outFiles) === JSON.stringify(expectedOut), outFiles.join(" "));
check("no source maps", !files.some((f) => f.endsWith(".map")));
check("only this Mac's node-pty prebuild", !files.some((f) => /prebuilds\/(darwin-x64|win32)/.test(f)) && fs.readdirSync(path.dirname(PTY)).join() === "darwin-arm64");
const home = os.homedir();
const leaks = expectedOut.filter((f) => extractFile(asar, f.slice(1)).toString("utf8").includes(home));
check("no home-folder path in the bundled code", leaks.length === 0, leaks.join(", "));

// ── Gatekeeper and the ticket ────────────────────────────────────────

const gk = run("spctl", ["--assess", "--type", "execute", "-vv", APP]);
check("Gatekeeper accepts the app as notarized", gk.code === 0 && /source=Notarized Developer ID/.test(gk.out), gk.out.match(/source=.*/)?.[0] ?? firstLine(gk.out));
const st = run("xcrun", ["stapler", "validate", APP]);
check("the app's ticket is stapled", st.code === 0, firstLine(st.out));

// ── the DMG ──────────────────────────────────────────────────────────

if (!argv.includes("--app-only")) {
  if (!fs.existsSync(DMG)) check("the DMG exists", false, DMG);
  else {
    const dsig = run("codesign", ["--verify", "--verbose=2", DMG]);
    check("the DMG is signed", dsig.code === 0 && signature(DMG).team === sig.team, firstLine(dsig.out));
    const dst = run("xcrun", ["stapler", "validate", DMG]);
    check("the DMG's ticket is stapled", dst.code === 0, firstLine(dst.out));
    const dgk = run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "-vv", DMG]);
    check("Gatekeeper accepts the DMG as notarized", dgk.code === 0 && /source=Notarized Developer ID/.test(dgk.out), dgk.out.match(/source=.*/)?.[0] ?? firstLine(dgk.out));
    // The app inside is the one checked above.
    const mnt = fs.mkdtempSync(path.join(os.tmpdir(), "aos-dmg-"));
    const at = run("hdiutil", ["attach", "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mnt, DMG]);
    if (at.code !== 0) check("the DMG mounts", false, firstLine(at.out));
    else {
      try {
        const inner = path.join(mnt, `${NAME}.app`);
        const same = fs.existsSync(inner) && signature(inner).cdhash === sig.cdhash;
        check("the DMG holds this app (same code directory hash)", same);
        check("the DMG offers the Applications folder", fs.existsSync(path.join(mnt, "Applications")));
      } finally { run("hdiutil", ["detach", mnt, "-quiet"]); fs.rmSync(mnt, { recursive: true, force: true }); }
    }
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
