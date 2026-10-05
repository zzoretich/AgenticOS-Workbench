// Builds the synthetic fixture once per run (scripts/make-fixture-vault.mjs) and keeps a pristine copy that every spec
// file restores from. AOS_E2E_REUSE_FIXTURE=1 skips the generator when a fixture from today already exists.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { FX, REPO, snapshotPristine } from "./harness";

export default async function globalSetup(): Promise<void> {
  const expectedFile = path.join(FX.root, "expected.json");
  const today = new Date().toDateString();
  // Reuse needs the pristine copy too: the live vault/ and home/ may carry a previous run's edits.
  const reusable = process.env.AOS_E2E_REUSE_FIXTURE === "1" && fs.existsSync(expectedFile) && fs.existsSync(path.join(FX.pristine, "vault"))
    && new Date(JSON.parse(fs.readFileSync(expectedFile, "utf8")).generatedAt).toDateString() === today;
  if (reusable) return;
  {
    const t0 = Date.now();
    execFileSync(process.execPath, [path.join(REPO, "scripts", "make-fixture-vault.mjs"), "--out", FX.root, "--quiet"], { stdio: "inherit" });
    const stages = JSON.parse(fs.readFileSync(path.join(FX.root, "stages.json"), "utf8")) as Array<{ stage: string; ok: boolean; error?: string }>;
    const failed = stages.filter((s) => !s.ok);
    console.log(`fixture: ${stages.length - failed.length}/${stages.length} runtime stages ok in ${((Date.now() - t0) / 1000).toFixed(1)} s${failed.length ? `; tolerated: ${failed.map((s) => `${s.stage} (${s.error})`).join("; ")}` : ""}`);
  }
  snapshotPristine();
}
