// The runtime check of every argument the page sends (main only). Each schema is typed against the contract in
// ../../shared/ipc.ts, so the compiler fails when a type and its schema drift apart. Sizes are generous for what the
// HUD sends and small enough that one call cannot exhaust main.

import { z } from "zod";
import type { ExecRequest, InstallRequest, PersonaAnswers, PtySpawnRequest, ReadyInfo, SetupFixId, SpawnRequest, WriteVia } from "../../shared/ipc";

const MB = 1024 * 1024;

/** An absolute path: no NUL, at most 4096 bytes. */
export const AbsPath = z.string().min(1).max(4096).refine((p) => p.startsWith("/") && !p.includes("\0"), "an absolute path");

/** A child's or a terminal's name, chosen by the page. */
const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/** An argument or a variable's value: text without NUL. */
const Text = (max: number) => z.string().max(max).refine((s) => !s.includes("\0"), "no NUL");

const EnvSet = z.record(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/), Text(4096)).refine((r) => Object.keys(r).length <= 32, "at most 32 variables");

const Signal = z.enum(["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP"]);

export const PathArgs = z.object({ p: AbsPath });
export const RangeArgs = z.object({ p: AbsPath, position: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), length: z.number().int().min(0).max(16 * MB) });
export const WriteArgs = z.object({ p: AbsPath, data: z.string().max(64 * MB), via: z.enum(["hud", "editor"]) satisfies z.ZodType<WriteVia> });
export const AppendArgs = z.object({ p: AbsPath, data: z.string().max(64 * MB) });
export const FolderArgs = z.object({ p: AbsPath, recursive: z.boolean() });
export const TwoPathArgs = z.object({ from: AbsPath, to: AbsPath });
export const NoArgs = z.object({}).strict();

export const SpawnRequestSchema: z.ZodType<SpawnRequest> = z.object({
  id: Id,
  cmd: Text(4096).refine((s) => s.length > 0, "a program"),
  args: z.array(Text(512 * 1024)).max(256),
  cwd: AbsPath.optional(),
  env: EnvSet.optional(),
  unsetEnv: z.array(z.string().regex(/^[A-Z_][A-Z0-9_]{0,63}$/)).max(8).optional(),
  stdio: z.enum(["pipe", "ignore"]).optional(),
  detached: z.boolean().optional(),
});

export const KillArgs = z.object({ id: Id, signal: Signal.optional() });

export const ExecRequestSchema: z.ZodType<ExecRequest> = z.object({
  file: Text(4096).refine((s) => s.length > 0, "a program"),
  args: z.array(Text(4096)).max(16),
  timeoutMs: z.number().int().min(1).max(60_000),
});

export const PtySpawnRequestSchema: z.ZodType<PtySpawnRequest> = z.object({
  id: Id,
  file: AbsPath,
  args: z.array(Text(4096)).max(16),
  cwd: AbsPath,
  name: z.string().regex(/^[a-z0-9-]{1,32}$/),
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(1000),
  env: EnvSet.optional(),
});

export const PtyWriteArgs = z.object({ id: Id, data: z.string().max(MB) });
export const PtyResizeArgs = z.object({ id: Id, cols: z.number().int().min(1).max(2000), rows: z.number().int().min(1).max(1000) });

export const UrlArgs = z.object({ url: z.string().max(8192) });

const PluginId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const PluginLoadArgs = z.object({ id: PluginId });
export const PluginSaveArgs = z.object({ id: PluginId, json: z.string().max(4 * MB) });

export const ReadyInfoSchema: z.ZodType<ReadyInfo> = z.object({
  commands: z.array(z.object({
    id: z.string().min(1).max(119),
    name: z.string().max(199),
    hotkeys: z.array(z.object({ modifiers: z.array(z.string().max(16)).max(4), key: z.string().max(32) })).max(8).optional(),
  })).max(500),
});

// ── setup (phase 5) ──────────────────────────────────────────────────

const FIX_IDS = ["homebrew", "node", "python", "uv", "ollama", "claude", "codex", "claude-login", "codex-login"] as const satisfies readonly SetupFixId[];

const Cols = z.number().int().min(1).max(2000);
const Rows = z.number().int().min(1).max(1000);

export const FixArgs = z.object({ id: z.enum(FIX_IDS), cols: Cols, rows: Rows });
export const SetupInputArgs = z.object({ data: z.string().max(64 * 1024) });
export const SetupResizeArgs = z.object({ cols: Cols, rows: Rows });

/** A model name as the CLIs take it (haiku, claude-sonnet-4-5, opus[1m], gpt-5.1-codex); blank for the default. */
const Model = z.string().trim().max(80).regex(/^[A-Za-z0-9._:/[\]-]*$/);

/** brain/scripts/persona/interview.js normalizeAnswers' rules, checked before `aos init` sees them. */
export const PersonaSchema: z.ZodType<PersonaAnswers> = z.object({
  name: z.string().trim().regex(/^[A-Za-z][A-Za-z0-9 _-]{1,39}$/),
  addressAs: Text(200),
  voice: Text(200),
  priorities: z.array(Text(200)).max(20),
  dutyModel: Model,
  dutyCodexModel: Model,
  dutyEffort: z.enum(["low", "medium", "high"]),
  schedule: z.boolean(),
});

export const InstallRequestSchema: z.ZodType<InstallRequest> = z.object({
  host: z.enum(["claude", "codex", "both"]),
  vault: Text(4096).refine((s) => s.trim().length > 0, "a folder"),
  persona: PersonaSchema.nullable(),
});
