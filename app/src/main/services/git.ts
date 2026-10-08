// A workspace's repository, for Sessions (spec 2026-10-07-unidex-sessions S9): what changed, one file's diff, and the
// commit the user asks for. Everything but commit only reads. Commit runs `git add -A` and `git commit -m <message>`
// only on the Commit button, with the message the user saw; nothing is ever pushed. git is the user's own (a bare
// name main's PATH finds), run without a shell in the workspace folder with a timeout. A file the page names must stay
// inside the workspace and follows `--`, so it is never read as an option.

import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GitDiff, GitStatus, Result } from "../../shared/ipc";
import { refused } from "./fs";

/** The most bytes of diff the page gets at once. */
export const DIFF_MAX = 2 * 1024 * 1024;
const STATUS_MAX = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export type WorkspaceDir = { dir: string } | { refusal: string };

export interface GitServiceOptions {
  /** The folder of a workspace by name, or why there is none (shared with the session service). */
  workspace: (name: string) => WorkspaceDir;
  /** Whether the Sessions surface is on. */
  enabled: () => boolean;
  env: NodeJS.ProcessEnv;
  execFileImpl?: typeof childProcess.execFile;
}

interface Run { code: number; stdout: string; stderr: string; truncated: boolean }

/** A file the page names: relative to the workspace, inside it, and plain text. */
export function fileRefusal(file: string): string | null {
  if (!file || file.length > 4096 || file.includes("\0")) return "a file name";
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) return "a file outside the workspace";
  return null;
}

/** `git status --porcelain=v2 --branch` → the parts the page shows. */
export function parseStatus(out: string): Omit<GitStatus, "repo" | "merging"> {
  let branch: string | null = null;
  let detached = false;
  const files: GitStatus["files"] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      detached = head === "(detached)";
      branch = detached ? null : head;
    } else if (line.startsWith("1 ")) {
      const f = line.split(" ");
      files.push({ status: f[1], path: f.slice(8).join(" "), added: null, removed: null });
    } else if (line.startsWith("2 ")) {
      const f = line.split(" ");
      files.push({ status: f[1], path: f.slice(9).join(" ").split("\t")[0], added: null, removed: null });
    } else if (line.startsWith("u ")) {
      const f = line.split(" ");
      files.push({ status: f[1], path: f.slice(10).join(" "), added: null, removed: null });
    } else if (line.startsWith("? ")) {
      files.push({ status: "??", path: line.slice(2), added: null, removed: null });
    }
  }
  return { branch, detached, files };
}

/** `git diff --numstat -z` → path → [added, removed], null for a binary file. A rename is keyed by its new path. */
export function parseNumstat(out: string): Map<string, [number | null, number | null]> {
  const counts = new Map<string, [number | null, number | null]>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(parts[i]);
    if (!m) continue;
    let file = m[3];
    if (file === "") { file = parts[i + 2] ?? ""; i += 2; }   // a rename: "a\tr\t" NUL old NUL new
    const n = (v: string): number | null => (v === "-" ? null : Number(v));
    if (file) counts.set(file, [n(m[1]), n(m[2])]);
  }
  return counts;
}

/** An untracked file's lines, all added; null for a binary or unreadable one. Reads at most UNTRACKED_READ bytes. */
export function untrackedLines(file: string): number | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, UNTRACKED_READ));
      fs.readSync(fd, buf, 0, buf.length, 0);
      if (buf.includes(0)) return null;
      if (!buf.length) return 0;
      let lines = 0;
      for (const b of buf) if (b === 10) lines += 1;
      return buf[buf.length - 1] === 10 ? lines : lines + 1;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** git's empty tree: what a repository with no commit yet is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const UNTRACKED_READ = 1024 * 1024;
const UNTRACKED_COUNTED = 200;

export class GitService {
  constructor(private readonly o: GitServiceOptions) {}

  private run(dir: string, args: readonly string[], maxBuffer = STATUS_MAX): Promise<Run> {
    const env = { ...this.o.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
    return new Promise((resolve) => {
      (this.o.execFileImpl ?? childProcess.execFile)("git", [...args], { cwd: dir, env, maxBuffer, timeout: TIMEOUT_MS, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        const truncated = !!e && e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const code = !e || truncated ? 0 : typeof e.code === "number" ? e.code : 1;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), truncated });
      });
    });
  }

  private dir(workspace: string): WorkspaceDir {
    if (!this.o.enabled()) return { refusal: "the Sessions surface is off" };
    return this.o.workspace(workspace);
  }

  async status(workspace: string): Promise<Result<GitStatus>> {
    const w = this.dir(workspace);
    if ("refusal" in w) return refused(w.refusal);
    return { ok: true, data: await this.statusOf(w.dir) };
  }

  private async statusOf(dir: string): Promise<GitStatus> {
    // The workspace's own repository only: a folder inside another one (a vault kept in git) is not a repository here,
    // or its status would be the vault's and Commit would add the whole vault.
    const top = await this.run(dir, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0 || !sameDir(top.stdout.trim(), dir)) return { repo: false, branch: null, detached: false, merging: false, files: [] };
    const s = await this.run(dir, ["status", "--porcelain=v2", "--branch", "--untracked-files=all"]);
    const mergeHead = await this.run(dir, ["rev-parse", "--git-path", "MERGE_HEAD"]);
    const merging = mergeHead.code === 0 && fs.existsSync(path.resolve(dir, mergeHead.stdout.trim()));
    const st = parseStatus(s.stdout);
    if (st.files.length) {
      // +/- per file (spec 2026-10-07-sessions-ux U11): tracked changes against HEAD, staged or not; untracked files count
      // their lines.
      const head = await this.run(dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
      const n = await this.run(dir, ["diff", "--numstat", "-z", head.code === 0 ? "HEAD" : EMPTY_TREE]);
      const counts = n.code === 0 ? parseNumstat(n.stdout) : new Map<string, [number | null, number | null]>();
      let untracked = 0;
      for (const f of st.files) {
        const c = counts.get(f.path);
        if (c) [f.added, f.removed] = c;
        else if (f.status === "??" && untracked++ < UNTRACKED_COUNTED) { f.added = untrackedLines(path.join(dir, f.path)); f.removed = f.added === null ? null : 0; }
        else if (f.status !== "??" && n.code === 0) { f.added = 0; f.removed = 0; }
      }
    }
    return { repo: true, merging, ...st };
  }

  async diff(workspace: string, file?: string): Promise<Result<GitDiff>> {
    const w = this.dir(workspace);
    if ("refusal" in w) return refused(w.refusal);
    if (file !== undefined) { const why = fileRefusal(file); if (why) return refused(why); }
    const st = await this.statusOf(w.dir);
    if (!st.repo) return refused("not a git repository");
    const hasHead = (await this.run(w.dir, ["rev-parse", "--verify", "--quiet", "HEAD"])).code === 0;
    const base = hasHead ? ["diff", "HEAD"] : ["diff"];
    const stat = await this.run(w.dir, [...base, "--stat"]);
    let text: Run;
    if (file === undefined) text = await this.run(w.dir, base, DIFF_MAX);
    else if ((await this.run(w.dir, ["ls-files", "--error-unmatch", "--", file])).code === 0) text = await this.run(w.dir, [...base, "--", file], DIFF_MAX);
    // A new file git does not track yet: its whole text as an addition (exit 1 means "they differ").
    else text = await this.run(w.dir, ["diff", "--no-index", "--", "/dev/null", file], DIFF_MAX);
    return { ok: true, data: { stat: stat.stdout, text: text.stdout, truncated: text.truncated } };
  }

  async commit(workspace: string, message: string): Promise<Result<{ commit: string }>> {
    const w = this.dir(workspace);
    if ("refusal" in w) return refused(w.refusal);
    const msg = message.trim();
    if (!msg) return refused("a commit needs a message");
    const st = await this.statusOf(w.dir);
    if (!st.repo) return refused("not a git repository");
    if (st.detached) return refused("HEAD is detached: check out a branch first");
    if (st.merging) return refused("a merge is in progress");
    if (!st.files.length) return refused("nothing to commit");
    const add = await this.run(w.dir, ["add", "-A"]);
    if (add.code !== 0) return { ok: false, error: lastLine(add.stderr) || "git add failed", code: "EIO" };
    const done = await this.run(w.dir, ["commit", "-m", msg]);
    if (done.code !== 0) return { ok: false, error: lastLine(done.stderr || done.stdout) || "git commit failed", code: "EIO" };
    const head = await this.run(w.dir, ["rev-parse", "HEAD"]);
    return { ok: true, data: { commit: head.stdout.trim() } };
  }
}

/** Whether two paths are one folder, links resolved (git prints the top level's real path). */
function sameDir(a: string, b: string): boolean {
  if (!a) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(b); } catch { return false; }
}

function lastLine(s: string): string {
  return s.trim().split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 300) ?? "";
}
