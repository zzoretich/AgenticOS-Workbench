// The guard log. Main decides every write, spawn and read the page asks for (src/main/policy, phase 4); when it refuses
// one, the page records it here and throws Node's EROFS, as the write guards did when they ran in the page. The log is
// what the e2e suite and the packaged smoke read (window.aosHost.guard).
//
// The page keeps one question of its own: whether the note editor may save a path, so a note it may not save opens
// without an Edit button. The host installs that rule (src/renderer/pagePolicy.ts); main still checks every save.

export interface GuardEntry {
  kind: "read" | "write" | "spawn";
  what: string;
  at: string;
}

export interface WriteGuard {
  /** Whether the note editor may save this absolute path. */
  canSave(target: unknown): boolean;
}

export interface GuardState {
  policy: WriteGuard;
  log: GuardEntry[];
}

const SAVES_NOTHING: WriteGuard = { canSave: () => false };

const g = globalThis as { __aosGuard?: GuardState };

export function guardState(): GuardState {
  g.__aosGuard ??= { policy: SAVES_NOTHING, log: [] };
  return g.__aosGuard;
}

export function setWriteGuard(policy: WriteGuard): void { guardState().policy = policy; }

export function canSave(target: unknown): boolean { return guardState().policy.canSave(target); }

/** Records an action main refused and returns the error to throw. */
export function refuse(kind: GuardEntry["kind"], what: string): Error {
  const entry: GuardEntry = { kind, what, at: new Date().toISOString() };
  const s = guardState();
  s.log.push(entry);
  if (s.log.length > 500) s.log.shift();
  console.warn(`[guard] refused ${kind}: ${what}`);
  const why = kind === "read" ? "outside what the app reads" : "no write surface that allows it is on";
  const err = new Error(`AgenticOS app: ${what} refused; ${why}`) as NodeJS.ErrnoException;
  err.code = "EROFS";
  return err;
}
