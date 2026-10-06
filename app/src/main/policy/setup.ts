// What the wizard and attach mode may run (phase 5, I4, I5). The page names a fix-it by id and a step by name; the
// commands, the program, the arguments and the files are main's. A fix-it is a fixed command line the user sees typed
// in the wizard's terminal before it runs: the installers macOS users already know (Homebrew's, `brew install`,
// `npm install -g` for the two CLIs), the two logins and `ollama pull` for Ollama's models. `aos init` and `aos upgrade`
// are the payload's own CLI run with the node preflight found, never through a shell.

import * as os from "node:os";
import * as path from "node:path";
import type { InstallRequest, PersonaAnswers, SetupCheckId, SetupFixId } from "../../shared/ipc";

export interface Fix {
  label: string;
  /** Run by /bin/sh -c in the wizard's terminal, with the login PATH (setup/env.ts). */
  command: string;
  /** The checks that must pass first (the fix needs brew, or npm, or the CLI it logs in to). */
  needs: SetupCheckId[];
}

/**
 * The models AgenticOS runs on Ollama: brain/scripts/sdk/lib/models.js's defaults for the workhorse and the embedder
 * (a unit test holds them equal). `auto` uses Ollama as soon as it answers, so the wizard leaves both downloaded.
 */
export const OLLAMA_MODELS = ["qwen3.5:9b", "qwen3-embedding:0.6b"] as const;

/** Where provider.js looks for Ollama before a vault has any config. */
export const OLLAMA_URL = "http://127.0.0.1:11434";

/**
 * curl asking Ollama as provider.js's node http does: -q (first) skips ~/.curlrc, and --noproxy keeps 127.0.0.1 off any
 * http_proxy or ALL_PROXY in main's environment, which node ignores.
 */
export const OLLAMA_CURL = ["-q", "--noproxy", "127.0.0.1", "-fs"] as const;

// The models' share of the Ollama fix-its. A service just started takes a few seconds to answer: curl asks once a
// second, for 30 s at most. The wait only ever follows `brew services start`, so its advice is Homebrew's. A model
// `ollama show` finds is already there; only a missing one is pulled, with Ollama's own progress. Brew's service is
// started for the formula; Ollama.app runs its own server once it is open, and carries the CLI it links onto the PATH
// at its first launch, so a PATH without `ollama` uses the app's copy.
const CURL = `curl ${OLLAMA_CURL.join(" ")}`;
const OLLAMA_WAIT = `{ echo "Waiting for Ollama to answer (up to 30 s)..."; ${CURL} --retry 30 --retry-delay 1 --retry-connrefused --retry-max-time 30 -m 2 -o /dev/null ${OLLAMA_URL}/api/tags || { echo "Ollama did not answer at ${OLLAMA_URL} within 30 s: run brew services restart ollama (brew services info ollama shows why), then Check again."; exit 1; }; }`;
const OLLAMA_START = `if ! ${CURL} -m 2 -o /dev/null ${OLLAMA_URL}/api/tags; then if brew list --formula ollama >/dev/null 2>&1; then brew services start ollama && ${OLLAMA_WAIT}; else echo "Ollama is not running: open Ollama, then try again."; exit 1; fi; fi`;
const OLLAMA_CLI = `O=$(command -v ollama) || for O in "$HOME/Applications/Ollama.app/Contents/Resources/ollama" /Applications/Ollama.app/Contents/Resources/ollama; do [ -x "$O" ] && break; done; [ -x "$O" ] || { echo "Ollama's command line tool was not found: open Ollama, then try again."; exit 1; }`;
const OLLAMA_PULL = `{ ${OLLAMA_CLI}; ${OLLAMA_MODELS.map((m) => `if "$O" show ${m} >/dev/null 2>&1; then echo "${m} is already downloaded."; else echo "Downloading ${m}..." && "$O" pull ${m}; fi`).join(" && ")}; }`;

export const FIXES: Record<SetupFixId, Fix> = {
  homebrew: {
    label: "Install Homebrew",
    command: '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
    needs: [],
  },
  node: { label: "Install Node.js", command: "brew install node", needs: ["homebrew"] },
  python: { label: "Install Python", command: "brew install python", needs: ["homebrew"] },
  uv: { label: "Install uv", command: "brew install uv", needs: ["homebrew"] },
  ollama: { label: "Install Ollama and its models", command: `brew install ollama && brew services start ollama && ${OLLAMA_WAIT} && ${OLLAMA_PULL}`, needs: ["homebrew"] },
  "ollama-models": { label: "Download the models", command: `${OLLAMA_START} && ${OLLAMA_PULL}`, needs: ["ollama"] },
  claude: { label: "Install Claude Code", command: "npm install -g @anthropic-ai/claude-code", needs: ["node"] },
  codex: { label: "Install the Codex CLI", command: "npm install -g @openai/codex", needs: ["node"] },
  "claude-login": { label: "Log in", command: "claude auth login", needs: ["claude"] },
  "codex-login": { label: "Log in", command: "codex login", needs: ["codex"] },
};

export const FIX_IDS = Object.keys(FIXES) as SetupFixId[];

/** Why a fix cannot run while only `ok` checks pass, else null. */
export function fixBlocked(id: SetupFixId, ok: ReadonlySet<SetupCheckId>): string | null {
  const missing = FIXES[id].needs.filter((n) => !ok.has(n));
  if (!missing.length) return null;
  const names: Partial<Record<SetupCheckId, string>> = { homebrew: "Homebrew", node: "Node.js", claude: "Claude Code", codex: "the Codex CLI", ollama: "Ollama" };
  return `needs ${missing.map((n) => names[n] ?? n).join(" and ")} first`;
}

/** The program and arguments of a fix-it's terminal. */
export function fixCommandLine(id: SetupFixId): { file: string; args: string[] } {
  return { file: "/bin/sh", args: ["-c", FIXES[id].command] };
}

/** A vault folder as the user typed or picked it: absolute, or ~/…; null when it is neither, or is home or a root. */
export function resolveVaultPath(input: string, home: string = os.homedir()): string | null {
  const raw = input.trim();
  const p = raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(p) || p.includes("\0")) return null;
  const abs = path.resolve(p);
  if (abs === path.resolve(home) || path.parse(abs).root === abs) return null;
  return abs;
}

/** The answers `aos init --persona-json` reads (persona/interview.js normalizeAnswers checks them again). */
export function personaJson(a: PersonaAnswers, hosts: { claude: boolean; codex: boolean }): Record<string, unknown> {
  return {
    name: a.name.trim(),
    addressAs: a.addressAs.trim(),
    voice: a.voice.trim(),
    priorities: a.priorities.map((p) => p.trim()).filter(Boolean),
    ...(hosts.claude && a.dutyModel.trim() ? { dutyModel: a.dutyModel.trim() } : {}),
    ...(hosts.codex && a.dutyCodexModel.trim() ? { dutyCodexModel: a.dutyCodexModel.trim() } : {}),
    dutyEffort: a.dutyEffort,
    schedule: a.schedule,
  };
}

/** `aos init`'s arguments: unattended (--yes), the user's host and folder, the persona answers when given. */
export function installArgs(cli: string, req: InstallRequest, vault: string, personaFile: string | null): string[] {
  return [cli, "init", "--yes", "--vault", vault, "--host", req.host, ...(personaFile ? ["--persona-json", personaFile] : [])];
}

export type SetupStep = "preflight" | "fix" | "install" | "upgrade" | "finish" | "claude-md";

export interface SetupState {
  /** A vault is attached (the Workbench is showing). */
  attached: boolean;
  /** `aos init` finished with exit 0 in this run. */
  installed: boolean;
  /** The app carries a runtime. */
  payload: boolean;
  /** The vault's runtime is older than the payload's. */
  behind: boolean;
  /** A fix, the install or an upgrade is running. */
  busy: boolean;
}

/** Why a step may not run now, or null. */
export function stepRefusal(step: SetupStep, s: SetupState): string | null {
  if (s.busy && step !== "claude-md" && step !== "preflight") return "another setup step is running";
  switch (step) {
    // The checks and their fixes are the wizard's: once a vault is attached, neither runs.
    case "preflight": case "fix": return s.attached ? "a vault is already attached" : null;
    case "install": return s.attached ? "a vault is already attached" : !s.payload ? "this build carries no runtime" : null;
    case "upgrade": return !s.payload ? "this build carries no runtime" : !s.attached ? "no vault is attached" : !s.behind ? "the vault's runtime is not behind this app's" : null;
    // Attaches only what agenticos.json names, which main reads itself: after the wizard's install, or a terminal's
    // `aos init`, or a vault folder that is back (an external disk).
    case "finish": return s.attached ? "a vault is already attached" : null;
    case "claude-md": return s.attached || s.installed ? null : "no vault yet";
  }
}
