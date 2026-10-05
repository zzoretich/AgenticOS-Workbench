// The write guard. The app runs against a live vault, so every write the compat layer or the HUD attempts, and every
// process it starts, is checked here first; what the installed policy does not allow is refused and recorded instead of
// reaching the disk. The fs and child_process shims in the app share this state and its log.
//
// The policy itself (which surfaces may write what) is the app's: src/shared/write-policy.ts. The host installs it at
// boot; until then nothing may write or spawn.

export interface GuardEntry {
  kind: "write" | "spawn";
  what: string;
  at: string;
}

export interface WriteGuard {
  /** Whether this absolute path (string, Buffer or file: URL) may be created, changed or removed. */
  canWrite(target: unknown): boolean;
  /** Whether this absolute folder path may be created (not removed). */
  canMakeFolder(target: unknown): boolean;
  /** Whether `cmd args…`, run without a shell from `cwd`, may start. */
  canSpawn(cmd: unknown, args?: readonly unknown[], cwd?: unknown): boolean;
  /** Whether the note editor may save this absolute path. The HUD's own writes never ask this. */
  canSave?(target: unknown): boolean;
}

export interface GuardState {
  policy: WriteGuard;
  log: GuardEntry[];
}

const REFUSE_ALL: WriteGuard = { canWrite: () => false, canMakeFolder: () => false, canSpawn: () => false };

const g = globalThis as { __aosGuard?: GuardState };

export function guardState(): GuardState {
  g.__aosGuard ??= { policy: REFUSE_ALL, log: [] };
  return g.__aosGuard;
}

export function setWriteGuard(policy: WriteGuard): void { guardState().policy = policy; }

export function canWrite(target: unknown): boolean { return guardState().policy.canWrite(target); }

export function canMakeFolder(target: unknown): boolean { return guardState().policy.canMakeFolder(target); }

export function canSpawn(cmd: unknown, args?: readonly unknown[], cwd?: unknown): boolean { return guardState().policy.canSpawn(cmd, args, cwd); }

export function canSave(target: unknown): boolean { return guardState().policy.canSave?.(target) ?? false; }

/** Records a refused action and returns the error to throw. */
export function refuse(kind: GuardEntry["kind"], what: string): Error {
  const entry: GuardEntry = { kind, what, at: new Date().toISOString() };
  const s = guardState();
  s.log.push(entry);
  if (s.log.length > 500) s.log.shift();
  console.warn(`[guard] refused ${kind}: ${what}`);
  const err = new Error(`AgenticOS app: ${what} refused; no write surface that allows it is on`) as NodeJS.ErrnoException;
  err.code = "EROFS";
  return err;
}
