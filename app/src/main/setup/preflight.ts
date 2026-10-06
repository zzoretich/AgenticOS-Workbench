// The wizard's first step (phase 5, I4): what `aos init` needs, checked the way `aos init` checks it, before anything is
// written. Node ≥ 20, Ollama, python3 ≥ 3.9 and uv are hard prerequisites; claude and codex are the hosts, and at least
// one must be installed and logged in. Homebrew is not needed by AgenticOS, only by most of the fix-its. Ollama's two
// models are not needed by `aos init` either, but `auto` runs background work on Ollama as soon as it answers, so a
// missing one is a warning with its fix. Each probe runs a program with a timeout and never through a shell; the probes
// are injected so the tests can stand in for the machine.

import * as path from "node:path";
import type { PreflightReport, SetupCheck, SetupCheckId } from "../../shared/ipc";
import { FIXES, OLLAMA_CURL, OLLAMA_MODELS, OLLAMA_URL, fixBlocked } from "../policy/setup";
import { findOnPath, isExecutable } from "./env";

export interface ProbeResult { code: number | null; out: string }

interface Found { ok: boolean; detail: string; warn?: boolean }

export interface PreflightDeps {
  /** The PATH to look on (env.ts loginPath). */
  PATH: string;
  home: string;
  run: (file: string, args: string[], timeoutMs: number) => Promise<ProbeResult>;
  isExec?: (p: string) => boolean;
  exists: (p: string) => boolean;
}

const LABELS: Record<SetupCheckId, string> = {
  homebrew: "Homebrew",
  node: "Node.js 20 or newer",
  claude: "Claude Code",
  "claude-login": "Claude Code login",
  codex: "Codex CLI",
  "codex-login": "Codex login",
  ollama: "Ollama",
  "ollama-models": "Ollama's models",
  python: "Python 3.9 or newer",
  uv: "uv",
};

/** "v22.12.0" → [22, 12]; "Python 3.13.1" → [3, 13]; null when there is no version in it. */
export function parseVersion(out: string): [number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.\d+)?/.exec(out);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const atLeast = (v: [number, number] | null, major: number, minor = 0): boolean => !!v && (v[0] > major || (v[0] === major && v[1] >= minor));

const firstLine = (s: string): string => s.trim().split("\n")[0]?.trim().slice(0, 120) ?? "";

/** The model names in Ollama's /api/tags answer; null when it did not answer with them. */
export function parseTags(r: ProbeResult | null): string[] | null {
  if (!r || r.code !== 0) return null;
  try {
    const models = (JSON.parse(r.out) as { models?: unknown }).models;
    if (!Array.isArray(models)) return null;
    return models.flatMap((m: { name?: unknown; model?: unknown }) => [m?.name, m?.model].filter((n): n is string => typeof n === "string"));
  } catch { return null; }
}

/** The report the page shows, and the node `aos init` will run with (main keeps it; the page never names a program). */
export async function runPreflight(d: PreflightDeps): Promise<{ report: PreflightReport; node: string | null }> {
  const isExec = d.isExec ?? isExecutable;
  const find = (name: string, more: string[] = []): string | null => findOnPath(name, d.PATH, isExec) ?? more.find((p) => isExec(p)) ?? null;
  const found: Partial<Record<SetupCheckId, Found>> = {};

  const brew = find("brew", ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]);
  found.homebrew = brew ? { ok: true, detail: brew } : { ok: false, detail: "not installed (only the fixes below use it)" };

  const node = find("node");
  const claude = find("claude", [path.join(d.home, ".local", "bin", "claude")]);
  const codex = find("codex");
  const uv = find("uv", [path.join(d.home, ".local", "bin", "uv"), path.join(d.home, ".cargo", "bin", "uv")]);
  const ollama = find("ollama") ?? ["/Applications/Ollama.app", path.join(d.home, "Applications", "Ollama.app")].find((p) => d.exists(p)) ?? null;
  // Asked over HTTP, as provider.js asks: `ollama list` would open Ollama.app, and a check starts nothing.
  const curl = ollama ? find("curl") : null;
  // macOS's /usr/bin/python3 is a stub that pops up the Command Line Tools installer when they are missing: ask
  // xcode-select first, and offer Homebrew's python instead of that dialog.
  let python = find("python3");
  if (python === "/usr/bin/python3" && (await d.run("/usr/bin/xcode-select", ["-p"], 5000)).code !== 0) python = null;

  const [nodeV, claudeV, claudeAuth, codexV, codexAuth, pythonV, tags] = await Promise.all([
    node ? d.run(node, ["--version"], 5000) : null,
    claude ? d.run(claude, ["--version"], 10_000) : null,
    claude ? d.run(claude, ["auth", "status", "--json"], 10_000) : null,
    codex ? d.run(codex, ["--version"], 10_000) : null,
    codex ? d.run(codex, ["login", "status"], 10_000) : null,
    python ? d.run(python, ["--version"], 5000) : null,
    curl ? d.run(curl, [...OLLAMA_CURL, "-m", "3", `${OLLAMA_URL}/api/tags`], 5000) : null,
  ]);

  const nv = nodeV ? parseVersion(nodeV.out) : null;
  found.node = !node ? { ok: false, detail: "not found" }
    : atLeast(nv, 20) ? { ok: true, detail: `${firstLine(nodeV?.out ?? "")} · ${node}` }
    : { ok: false, detail: `${firstLine(nodeV?.out ?? "") || "no version"} at ${node}: AgenticOS needs 20 or newer` };

  found.claude = claude ? { ok: true, detail: `${firstLine(claudeV?.out ?? "") || "installed"} · ${claude}` } : { ok: false, detail: "not installed" };
  let claudeIn = false;
  try { claudeIn = !!(JSON.parse(claudeAuth?.out ?? "") as { loggedIn?: boolean }).loggedIn; } catch { /* not JSON: not logged in */ }
  found["claude-login"] = !claude ? { ok: false, detail: "install Claude Code first" } : claudeIn ? { ok: true, detail: "logged in" } : { ok: false, detail: "not logged in" };

  found.codex = codex ? { ok: true, detail: `${firstLine(codexV?.out ?? "") || "installed"} · ${codex}` } : { ok: false, detail: "not installed" };
  // `aos init`'s rule (cli/codex-host.js codexLoggedIn): exit 0 and "logged in", not "not logged in".
  const codexIn = !!codexAuth && codexAuth.code === 0 && /logged in/i.test(codexAuth.out) && !/not logged in/i.test(codexAuth.out);
  found["codex-login"] = !codex ? { ok: false, detail: "install the Codex CLI first" } : codexIn ? { ok: true, detail: "logged in" } : { ok: false, detail: "not logged in" };

  found.ollama = ollama ? { ok: true, detail: ollama } : { ok: false, detail: "not installed" };
  const have = parseTags(tags);
  const lacking = OLLAMA_MODELS.filter((m) => !have?.includes(m));
  found["ollama-models"] = !ollama ? { ok: false, warn: true, detail: "install Ollama first (its fix downloads them too)" }
    : !have ? { ok: false, warn: true, detail: "Ollama is not running, so they could not be checked" }
    : lacking.length ? { ok: false, warn: true, detail: `not downloaded: ${lacking.join(", ")}` }
    : { ok: true, detail: OLLAMA_MODELS.join(" · ") };
  const pv = pythonV ? parseVersion(pythonV.out) : null;
  found.python = !python ? { ok: false, detail: "not found" }
    : atLeast(pv, 3, 9) ? { ok: true, detail: `${firstLine(pythonV?.out ?? "")} · ${python}` }
    : { ok: false, detail: `${firstLine(pythonV?.out ?? "") || "no version"} at ${python}: AgenticOS needs 3.9 or newer` };
  found.uv = uv ? { ok: true, detail: uv } : { ok: false, detail: "not installed" };

  const hosts = { claude: !!found.claude?.ok && !!found["claude-login"]?.ok, codex: !!found.codex?.ok && !!found["codex-login"]?.ok };
  const okIds = new Set((Object.keys(found) as SetupCheckId[]).filter((id) => found[id]?.ok));
  const REQUIRED: SetupCheckId[] = ["node", "ollama", "python", "uv"];
  const ORDER: SetupCheckId[] = ["homebrew", "node", "claude", "claude-login", "codex", "codex-login", "ollama", "ollama-models", "python", "uv"];
  const checks: SetupCheck[] = ORDER.map((id) => {
    const f: Found = found[id] ?? { ok: false, detail: "not checked" };
    const fixId = f.ok ? null : FIXES[id as keyof typeof FIXES] ? (id as keyof typeof FIXES) : null;
    const fix = fixId ? FIXES[fixId] : null;
    return {
      id, label: LABELS[id], state: f.ok ? "ok" : f.warn ? "warn" : "missing", detail: f.detail, required: REQUIRED.includes(id),
      fix: fixId, fixLabel: fix?.label ?? null, fixCommand: fix?.command ?? null, fixBlocked: fixId ? fixBlocked(fixId, okIds) : null,
    };
  });
  const ready = REQUIRED.every((id) => okIds.has(id)) && (hosts.claude || hosts.codex);
  return { report: { checks, hosts, ready }, node: found.node?.ok ? node : null };
}
