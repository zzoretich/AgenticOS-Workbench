# Codex host support — implementation plan

Spec: `docs/superpowers/specs/2026-09-21-codex-compat-design.md` · Branch: `feat/codex-compat`

Four phases, each a mergeable PR on its own. Phase 1 has no user-visible behaviour change
under Claude Code; phases 2–4 are additive. Every task ends with `npm run gate && npm test`.

## Task 0 — spike (manual, before phase 1)

On the owner's machine with the real `codex` CLI, using a throwaway `CODEX_HOME`:

- [ ] Write a `hooks.json` with one entry per event whose command appends the stdin JSON to a
      file; open the TUI, send one prompt, quit; then `codex exec 'say hi'`. Record which
      events fired in each mode and the exact payload keys.
- [ ] Confirm a Stop hook that prints nothing, and one that prints `{}`, are both accepted.
- [ ] Confirm `transcript_path` points at the rollout file for every event.
- [ ] Record the `tool_name` values seen for a shell command, a file edit, and an MCP call.
- [ ] Confirm `codex exec -c features.hooks=false` suppresses the hooks.
- [ ] Note the trust prompt behaviour (`/hooks`) and whether `codex exec` runs untrusted hooks.

Write the findings as a "Spike results" section at the bottom of this file. Any contradiction
with the spec is fixed in the spec before task 1.

## Phase 1 — host layer and hook contracts (brain/scripts)

- [ ] 1.1 `brain/scripts/lib/host.js` + `test/host.test.js`.
- [ ] 1.2 `detach.js` uses `host.isHookInvocation()`; existing tests still pass with
      `CLAUDE_PROJECT_DIR`, new case with `AOS_HOST=codex`.
- [ ] 1.3 `hook-entry.js` `finishStop()`; `update-session.js`, `heartbeat-writer.js` call it.
- [ ] 1.4 `scan-vault.js` gains `respawnDetached()` under a hook invocation.
- [ ] 1.5 `inject-conventions.js` + `bin/aos` case arm + test.
- [ ] 1.6 `lib/transcript.js` with Claude and Codex readers; fixture
      `test/fixtures/codex-rollout.jsonl`; `heuristics.js`, `inject-context.js`,
      `update-session.js`, `auto-wrap.js` read through it.
- [ ] 1.7 `telemetry-hook.js` tool-kind mapping via the adapter.
- [ ] 1.8 `config.default.json` `codex` block; `lib/config.js` merge test.

## Phase 2 — provider and costing

- [ ] 2.1 `sdk/lib/codex-cli.js` + `test/codex-cli.test.js` (spawn seam, JSON parse,
      `ProviderUnavailable` on not-logged-in).
- [ ] 2.2 `models.js` role `codex`; `provider.js` `makeCodex()`, budgets, login cache,
      chain order ollama → claude → codex → none; `provider.test.js` cases.
- [ ] 2.3 `extras/cost/pricing.json` `openai` block; `auto-cost.js` host routing +
      `costCodexRollout()`; `test/auto-cost-codex.test.js`.
- [ ] 2.4 `aos provider` output shows the codex row.

## Phase 3 — installer, doctor, skills

- [ ] 3.1 `cli/aos.js` `buildUserConfig()` writes `hosts`; upgrade migration test.
- [ ] 3.2 `cli/codex-host.js`: `installCodexHost`, `removeCodexHost`, `codexHostStatus`,
      `commandToSkill`; `cli/codex-host.test.js`.
- [ ] 3.3 `aos init --host claude|codex|both` (default: detect); preflight "at least one
      host logged in"; `~/.codex` vault refusal; checklist text.
- [ ] 3.4 `aos doctor` per-host rows; `aos uninstall --host`; `aos upgrade` regenerates
      skills and re-merges hooks.
- [ ] 3.5 `vendorRuntime()` copies `plugin/{commands,skills}` into
      `<vault>/brain/scripts/plugin/`.
- [ ] 3.6 Collectors gated on `hosts.claude.enabled`.
- [ ] 3.7 `cli/fixtures/fake-codex.sh`; `cli/rehearsal/first-run.sh --host codex`;
      CI matrix entry.

## Phase 4 — docs and vault seed

- [ ] 4.1 README (prerequisites, install §4b, How it works diagram, layout line).
- [ ] 4.2 `docs/install.md`, `docs/plugin-smoke.md` Codex list, `docs/cost.md` note.
- [ ] 4.3 `vault-template/AGENTICOS.md`, `profile.md`, `brain/routines/README.md`.
- [ ] 4.4 `cli/vault-template.test.js`, `cli/plugin-commands.test.js` updates.
- [ ] 4.5 Version bump to 0.5.0 at release (`npm run version:bump 0.5.0`).

## File structure

| Path | Change | Phase |
|---|---|---|
| `brain/scripts/lib/host.js` | new | 1 |
| `brain/scripts/lib/transcript.js` | new | 1 |
| `brain/scripts/inject-conventions.js` | new | 1 |
| `brain/scripts/lib/{detach,hook-entry,heuristics}.js` | edit | 1 |
| `brain/scripts/{inject-context,update-session,auto-wrap,telemetry-hook,scan-vault}.js` | edit | 1 |
| `brain/scripts/config.default.json` | edit | 1 |
| `brain/scripts/test/fixtures/codex-rollout.jsonl` | new | 1 |
| `brain/scripts/sdk/lib/codex-cli.js` | new | 2 |
| `brain/scripts/sdk/lib/{provider,models}.js` | edit | 2 |
| `brain/scripts/{auto-cost,cost-sync}.js` | edit | 2 |
| `extras/cost/pricing.json` | edit | 2 |
| `cli/codex-host.js`, `cli/codex-host.test.js` | new | 3 |
| `cli/aos.js`, `cli/aos.test.js` | edit | 3 |
| `cli/fixtures/fake-codex.sh` | new | 3 |
| `cli/rehearsal/first-run.sh`, `.github/workflows/ci.yml` | edit | 3 |
| `plugin/bin/aos` | edit (two case arms) | 1, 3 |
| `brain/scripts/collectors/{config,capabilities,runtime,folderAtlas,health}.js` | edit | 3 |
| `README.md`, `docs/install.md`, `docs/plugin-smoke.md`, `docs/cost.md` | edit | 4 |
| `vault-template/AGENTICOS.md`, `vault-template/brain/memory/user/profile.md` | edit | 4 |

## Spike results

_(filled in after task 0)_
