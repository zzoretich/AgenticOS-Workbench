import { App } from "obsidian";

export const SNAPSHOT_PATH = "brain/_index/snapshot.json";
export const SNAPSHOT_HISTORY_DIR = "brain/_index/snapshots";

// ── config ───────────────────────────────────────────────────────

export interface SnapshotSettings {
  path?: string;
  model: string | null;
  theme: string | null;
  effortLevel: string | null;
  dangerousMode: boolean;
  hookCount: number;
  hookEvents: string[];
  permissionsAllow: number;
  permissionsDefaultMode: string;
  statusLine: string | null;
  autoUpdatesChannel: string | null;
}

export interface ConfigFileMeta {
  size: number;
  mtime: string;
  lines?: number;
  pointers?: number;
}

export interface GsdManifestMeta {
  present: boolean;
  fileCount: number;
  version: string;
  timestamp: string;
}

export interface SnapshotConfig {
  settings: SnapshotSettings;
  claudeMd?: ConfigFileMeta;
  memoryMd?: ConfigFileMeta;
  gsdManifest?: GsdManifestMeta;
  historyJsonl?: ConfigFileMeta;
  topLevelFiles?: { packageJson?: boolean; gitignore?: boolean; credentials?: boolean };
  stray?: string[];
}

// ── capabilities ─────────────────────────────────────────────────

export interface SnapshotCapabilities {
  agents: { count: number; gsd: number; custom: string[]; totalBytes: number };
  commands: { count: number; names: string[] };
  skills: { count: number; gsd?: number; customCount?: number; custom?: string[]; missingSkillMd?: string[] };
  hooks: {
    count: number;
    wired?: number;
    orphans?: string[];
    acknowledgedOrphans?: string[];
    missingRefs?: string[];
    settingsReferenced?: number;
  };
  brainScripts?: { count: number; names?: string[]; wired?: number };
  pluginsTopLevel?: { present?: boolean; count: number };
}

// ── brain ────────────────────────────────────────────────────────

export interface SnapshotBrain {
  counts: {
    memoryByType?: Record<string, number>;
    memoryTotal?: number;
    patterns?: number;
    reflections?: number;
    sessions?: number;
    templates?: number;
    [k: string]: number | Record<string, number> | undefined;
  };
  sessions: {
    count?: number;
    today?: string;
    todayPresent?: boolean;
    streak?: number;
    latestDate?: string;
    oldestDate?: string;
    active?: number;
    stale?: number;
  };
  indexFiles: {
    brainMd?: { present: boolean; size: number; mtime: string; ageDays: number };
    sessionMd?: { present: boolean; size: number; mtime: string; ageDays: number };
    dashboardMd?: { present: boolean; size: number; mtime: string; ageDays: number };
    bases?: string[];
    [k: string]: unknown;
  };
  templates?: string[];
  reflectionsLatest?: string;
  memoryIndex?: {
    byType?: Record<string, number>;
    lastTouched?: { name: string; mtime: string };
    pointerCount?: number;
    brokenPointers?: string[];
    orphanMemories?: string[];
    orphanPatterns?: string[];
  };
  oldestMemories?: Array<{ path: string; ageDays: number; mtime: string }>;
}

// ── projects ─────────────────────────────────────────────────────

export interface ProjectEntry {
  name: string;
  kind: string;
  decodedCwd?: string;
  path: string;
  jsonlCount?: number;
  totalBytes: number;
  latestMtime?: string;
  latestAgeDays?: number;
  // user-named project fields
  fileCount?: number;
  mtime?: string;
  ageDays?: number;
  hasClaudeMd?: boolean;
  hasReadme?: boolean;
  linkedMemory?: string | null;
  // workspaces visibility (added 2026-05-31)
  status?: string;
  statusSource?: 'status.md' | 'handoff.md' | 'derived';
  nextStep?: string | null;
  summary?: string | null;
  lastEvent?: { iso: string | null; ageDays: number | null; subject: string | null };
}

export interface SessionEntry {
  uuid: string;
  hasJsonl: boolean;
  projectName: string;
  jsonlPath: string;
  jsonlBytes: number;
  records: number;
  hasTasks: boolean;
  hasLock: boolean;
  taskAgeDays: number | null;
  hasEnv: boolean;
  envBytes: number;
  hasFileHistory: boolean;
  fileHistoryBytes: number;
  lastActivity: string;
  ageDays: number;
  stale: boolean;
}

export interface SnapshotProjects {
  projects: ProjectEntry[];
  sessions: SessionEntry[];
  orphanUuids: { sessionEnv?: string[]; tasks?: string[]; fileHistory?: string[] };
  transientUuids?: { sessionEnv?: string[]; tasks?: string[]; fileHistory?: string[]; minAgeMinutes?: number };
  staleSessionCount: number;
  activeSessionCount: number;
  summary: {
    totalProjects: number;
    runtimeCwdProjects?: number;
    userNamedProjects?: number;
    userNamedWithoutMemory?: number;
    totalSessions: number;
    totalJsonlBytes: number;
    totalRecords: number;
  };
}

// ── workspaces (added 2026-05-31) ────────────────────────────────

export type WorkspaceSource = "manifest" | "derived" | "ai";

export interface WorkspaceObjective {
  text: string;
  source: WorkspaceSource;
}

export interface WorkspaceSubproject {
  name: string;
  path: string;            // vault-relative, e.g. "workspaces/Example Workspace"
  status?: string | null;
  summary?: string | null;
}

export interface WorkspaceDoc {
  name: string;
  path: string;            // vault-relative
}

export interface WorkspaceInsight {
  text: string | null;
  status: "ok" | "unavailable";
  model?: string;          // provider model tag, or "heuristic"
  generatedAt?: string;    // ISO
  inputHash?: string;
}

export interface WorkspaceEntry {
  name: string;
  path: string;            // vault-relative "workspaces/<name>"
  absPath?: string;        // absolute fs path recorded at scan time (for the file tree)
  status: string | null;
  statusSource: WorkspaceSource;
  summary: string | null;
  summarySource: WorkspaceSource;
  objectives: WorkspaceObjective[];
  isCollection: boolean;
  subprojects: WorkspaceSubproject[];  // populated when isCollection
  docs: WorkspaceDoc[];                // key docs when !isCollection
  next: { text: string | null; source: WorkspaceSource };
  insight: WorkspaceInsight;
  lastEvent: { iso: string | null; ageDays: number | null; subject: string | null };
  inputHash: string;       // hash of insight inputs, for cache carry-forward
}

// ── plans ────────────────────────────────────────────────────────

export interface PlanEntry {
  name: string;
  path: string;
  size: number;
  mtime: string;
  ageDays: number;
  title: string;
  explicitStatus: string | null;
  checkboxes: { total: number; done: number; pct: number | null };
  sections: string[];
  lifecycleStatus: string;
}

export interface SnapshotPlans {
  plans: PlanEntry[];
  summary: {
    total: number;
    active: number;
    stale: number;
    dormant: number;
    complete: number;
    totalCheckboxes: number;
    totalCheckboxesDone: number;
  };
}

// ── runtime ──────────────────────────────────────────────────────

export interface RuntimeBucket {
  count: number;
  totalBytes: number;
  oldest?: { name: string; mtime?: string; ageDays: number };
  newest?: { name: string; mtime?: string; ageHours?: number };
  warnLarge?: boolean;
}

export interface SnapshotRuntime {
  backups?: RuntimeBucket;
  shellSnapshots?: RuntimeBucket;
  cache?: { files: Array<{ name: string; size: number; ageDays: number }>; totalBytes: number };
  downloads?: { count: number; totalBytes: number; warnLarge?: boolean };
  ide?: { lockFiles?: string[]; active: boolean };
  runtimeSessions?: { count: number; files: Array<{ name: string; size: number; mtime: string }> };
}

// ── gsd ──────────────────────────────────────────────────────────

export interface SnapshotGsd {
  installed: boolean;
  version: string;
  counts: { bin?: number; contexts?: number; references?: number; templates?: number; workflows?: number };
  manifest: {
    present: boolean;
    fileCount: number;
    manifestVersion?: string;
    manifestTimestamp?: string;
    missing?: string[];
    drift: number;
  };
}

// ── folder atlas ─────────────────────────────────────────────────

export interface FolderAtlasEntry {
  name: string;
  present: boolean;
  entries?: number;
  files?: number;
  bytes?: number;
  newestMtime?: string;
  mtime?: string;
}

// ── health ───────────────────────────────────────────────────────

export interface HealthIssue {
  severity: "warn" | "error" | "info";
  area: string;
  message: string;
  detail?: unknown;
}

export interface SnapshotHealth {
  issues: HealthIssue[];
  counts?: { error: number; warn: number; info: number; total: number };
}

// ── maintenance ──────────────────────────────────────────────────

export interface SnapshotMaintenance {
  orphanSweep?: {
    enabled: boolean;
    swept: { sessionEnv?: string[]; fileHistory?: string[] };
    skipped: { nonEmpty: number; hasJsonl: number; tooYoung: number; error: number };
  };
}

// ── history (embedded current/previous/sevenDayAgo/thirtyDayAgo) ──

export interface HistoryRecord {
  date: string;
  scannedAt: string;
  totalBytes: number;
  folderBytes: Record<string, number>;
  counts: {
    agents: number;
    commands: number;
    skills: number;
    hooks: number;
    hooksWired?: number;
    brainScripts?: number;
    memories: number;
    patterns: number;
    reflections?: number;
    sessions: number;
  };
  health: { error: number; warn: number; info: number; total: number };
  plans?: { total: number; totalCheckboxes: number; done: number; complete: number };
  projects?: { projects: number; sessions: number; records: number; jsonlBytes: number; active: number; stale: number };
}

export interface SnapshotHistory {
  records: number;
  earliestDate?: string;
  latestPriorDate?: string;
  current?: HistoryRecord;
  previous?: HistoryRecord | null;
  sevenDayAgo?: HistoryRecord | null;
  thirtyDayAgo?: HistoryRecord | null;
}

// ── top-level snapshot ───────────────────────────────────────────

export interface Snapshot {
  scannedAt: string;
  vault: string;
  scanVersion: number;
  elapsedMs: number;
  maintenance?: SnapshotMaintenance;
  config: SnapshotConfig;
  capabilities: SnapshotCapabilities;
  brain: SnapshotBrain;
  projects?: SnapshotProjects;
  workspaces?: WorkspaceEntry[];
  plans?: SnapshotPlans;
  runtime?: SnapshotRuntime;
  gsd?: SnapshotGsd;
  folderAtlas?: FolderAtlasEntry[];
  health: SnapshotHealth;
  history?: SnapshotHistory;
}

// ── loaders ──────────────────────────────────────────────────────

export async function loadSnapshot(app: App): Promise<Snapshot | null> {
  try {
    const raw = await app.vault.adapter.read(SNAPSHOT_PATH);
    return JSON.parse(raw) as Snapshot;
  } catch (err) {
    console.error("[agentic-os] failed to load snapshot:", err);
    return null;
  }
}

// ── daily-snapshot history (separate per-day files) ──────────────

export interface DailySnapshot {
  date: string;
  scannedAt: string;
  totalBytes: number;
  counts: {
    agents: number;
    commands: number;
    skills: number;
    hooks?: number;
    hooksWired?: number;
    brainScripts?: number;
    memories: number;
    patterns: number;
    reflections?: number;
    sessions: number;
  };
  health: { error: number; warn: number; info: number; total: number };
  plans?: { total: number; totalCheckboxes: number; done: number; complete: number };
  projects?: { projects: number; sessions: number; records: number; jsonlBytes: number; active: number; stale: number };
  folderBytes?: Record<string, number>;
}

export async function loadSnapshotHistory(app: App, limit = 21): Promise<DailySnapshot[]> {
  try {
    const list = await app.vault.adapter.list(SNAPSHOT_HISTORY_DIR);
    const files = (list.files || [])
      .filter((p) => p.endsWith(".json"))
      .sort();
    const tail = files.slice(-limit);
    const out: DailySnapshot[] = [];
    for (const f of tail) {
      try {
        const raw = await app.vault.adapter.read(f);
        const d = JSON.parse(raw) as DailySnapshot;
        out.push(d);
      } catch {
        /* skip malformed */
      }
    }
    return out;
  } catch (err) {
    console.error("[agentic-os] failed to load snapshot history:", err);
    return [];
  }
}

export type CountKey = "agents" | "commands" | "skills" | "memories" | "patterns" | "sessions";

export function seriesFromHistory(history: DailySnapshot[], key: CountKey): number[] {
  return history.map((d) => (d.counts as Record<string, number>)[key] ?? 0);
}
