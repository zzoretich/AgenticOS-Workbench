---
name: cross-review
description: Harden a plan with an independent review by the other provider (Claude Code and Codex review each other), then optionally build it and have the provider that did not build inspect the final diff in a fresh session. Adapted from claudex-loop. Use when the user says "cross-review this plan", "cross-review this feature and implement it", "have the other model review this plan", "claudex this plan", or wants a plan checked before building; not for trivial edits.
---

# Cross-review

The current conversation owns requirements, planning and coordination. The other provider reviews the plan. Either
provider can build; the provider that did not build inspects the final code in a fresh session. Every call to another
model goes through the AgenticOS runner, which runs one isolated, unsaved child session per call, checks its reply,
binds an approval to the plan's hash, and records the spend on the `crossReview` budget.

## The runner

`RUNNER` below means `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" cross-review`. Every command already carries `--host claude`,
the host this conversation runs in: keep it exactly as written, never infer it from installed binaries.

- The first line of output is a JSON object with the run's `artifacts` directory; its `result.json` is the record
  (`status`, `response`, `independence`, `planSha256`, `requestedModel`, `observedModels`, `usd`, `error`).
- **Exit 0 means a completed turn, not approval**: read `response.verdict`. Exit 1: a failed or refused turn; read
  `error` (or stderr) and report it. Exit 2: a usage mistake; fix the command.
- A turn can take minutes (the timeout is `crossReview.timeoutSec`, default 600 s). When your shell tool can run a
  command in the background, run it that way and keep the user posted; otherwise pass `--timeout` within your shell's
  limit. Never retry blindly: a failed turn is reported, not repeated.
- Keep plan and log files where the user wants them (`PLAN.md` and `PLAN-REVIEW-LOG.md` at the repo root by default).
  Write dispositions, fix lists and briefs outside the checkout, so they never enter its diff.

## Resolve roles once

Run `RUNNER preflight --host claude`. It prints the roles, each CLI's path, version and login (no model call), today's
spend against `crossReview.perDayUsd`, and the independence available.

| Host | Requirements and plan | Plan reviewer | Default builder | Final inspector |
|---|---|---|---|---|
| Claude Code | This Claude Code conversation | Codex | Claude | A fresh Codex session |
| Codex | This Codex conversation | Claude | Codex | A fresh Claude session |

Honour `builder=claude|codex`; the inspector is always opposite the builder, and the host stays coordinator. To swap
the planner, the user starts the conversation in the other host.

- **Exit 0 (cross-provider):** proceed.
- **Exit 3 (same-provider only):** the other CLI is missing or logged out; the line says which. Tell the user, and
  offer a **same-provider review**: `--same-provider` on `review` and `inspect` runs a fresh, isolated session of this
  host's own CLI. Label it that way in the log and in everything you tell the user; never call it an independent or
  cross-provider approval. Building on such an approval needs `--accept-same-provider`, which only the user can
  authorise.
- **Exit 1:** nothing can run; report why and stop.

## Tunables

| Argument | Default | Meaning |
|---|---|---|
| `plan` / `PLAN_FILE` | `PLAN.md` | Plan path, carried through every phase and the build handoff |
| `log` / `LOG_FILE` | `PLAN-REVIEW-LOG.md` | Append-only record of findings, dispositions, models and proof |
| `rounds` / `MAX_ROUNDS` | `crossReview.rounds` (5) | Maximum completed plan-review rounds |
| `builder` | the host | Provider implementing the plan |
| `mode` | `full` | `full` includes recon and requirements; `review` starts from an existing plan |
| `research` | proportionate | `none`, `web`, or explicitly requested `deep` |
| `inspect` | `on` | `off` only when the user explicitly opts out; record it |
| `MAX_FIX_ROUNDS` | 2 | Bounded build-fix attempts before reporting or taking over |
| `MAX_INSPECTION_ROUNDS` | 2 | Initial inspection plus one after fixes |
| `reviewer_model`, `builder_model`, `inspector_model` | `crossReview.claudeModel` / `codexModel` (null = the CLI's default) | `--model` on that role's calls |
| `reviewer_effort`, `builder_effort`, `inspector_effort` | `crossReview.effort` | `--effort`; the runner refuses one the chosen CLI does not take |

Echo roles, paths, round limits, requested models, independence and any inspection opt-out before starting. Preserve
the user's authorization: a request to plan does not authorise building; a request to plan and implement does. A model
chosen in the host's UI says nothing about which model a separate CLI runs: report requested and observed models
separately, and an unresolved CLI default honestly.

## Phase 0 — Recon

For existing projects, inspect the relevant code, dependencies, and callers and writers of shared state. Read existing
`CONTEXT.md` / `CONTEXT-MAP.md` and relevant ADRs. For greenfield work, research prior art, a reasonable stack and
concrete failure modes when useful; respect an explicit research depth.

When the agenticos memory tools are available, query `recall` (`mcp__plugin_agenticos_agenticos__recall`) for the
project, its components and past decisions, and `feedback_rules` (`mcp__plugin_agenticos_agenticos__feedback_rules`)
for the user's standing instructions. Put relevant hits in the assumptions ledger with their vault paths; a feedback
rule outranks your own default.

Do not assume this host's MCP servers, browser, credentials or skills exist for the other CLI: its children run with
none of them. Present one assumptions ledger with source paths or links, and ask for corrections to material
uncertainties as one batch.

## Phase 1 — Settle requirements

Keep a short visible decision map. Ask only about unresolved decisions that change the outcome; for each, give the
recommendation, why it matters, and the cost of guessing wrong. Batch independent questions; if the code can answer,
read it instead. Offer "accept all remaining recommendations" when the list is long.

Respect existing glossary definitions; keep a glossary-only context lazily using
[CONTEXT-FORMAT.md](CONTEXT-FORMAT.md). Record an ADR only for an expensive-to-reverse, non-obvious trade-off using
[ADR-FORMAT.md](ADR-FORMAT.md).

Write `PLAN_FILE` with: the goal and observable acceptance criteria; the approach, key decisions, trade-offs and
non-goals; confirmed assumptions with sources and remaining risks; toolchain needs per provider; and verification —
exact proof commands, expected results, and manual or visual checks. Start `LOG_FILE` with roles, requested models,
independence, scope, authorization and round limits.

With `mode=review`, load the supplied plan, fill only material gaps, and go straight to Phase 2.

## Phase 2 — Independent plan review

First round:

```sh
sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" cross-review review --host claude --repo <repo> --plan <plan> [--model <m>] [--effort <e>]
```

Each completed reply has a verdict, evidence-backed findings, actual coverage and limitations. Append the whole
response and the `result.json` path to `LOG_FILE`.

- **APPROVED:** no unresolved material defects, bound to this plan's path and SHA256. Present remaining low-priority
  advice and limitations; zero findings is valid and is not proof of exhaustive correctness.
- **REVISE:** arbitrate each finding. Make warranted plan changes, reject unsupported ones with reasons, and record
  the dispositions. Write them to a file outside the checkout and send the revised plan back:

  ```sh
  sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" cross-review review --host claude --repo <repo> --plan <plan> --prior <previous result.json> --feedback <dispositions file>
  ```

  Repeat the same `--model` and `--effort` every round; the runner refuses a mismatched prior. Each round is a fresh
  session that receives the prior findings and your dispositions, so do not relitigate resolved points without new
  evidence.
- **BLOCKED, a failed turn, or a malformed result:** never approval. Explain the missing evidence or the failure; do
  not burn rounds on blind retries or switch providers silently.

Stop at `MAX_ROUNDS` and present unresolved findings with your position rather than manufacturing convergence. A
changed plan needs another review. Before building, confirm the approval still matches:

```sh
sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" cross-review check --host claude --repo <repo> --plan <plan> --approval <approved result.json>
```

If the user explicitly chooses to build without an approval, record that override and use `--unreviewed-spec`; never
label it approved.

## Phase 3 — Build and inspect

Present the reviewed plan, the improvements and the remaining limits; if implementation is not yet authorised, ask.
Read [the build reference](references/build.md) first.

The host can implement directly with its normal tools. For the other provider as builder (clean checkout required):

```sh
sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" cross-review build --host claude --builder codex --repo <repo> --plan <plan> --approval <approved result.json> --proof "<proof command>"
```

A fix round: the same command plus `--prior <previous build result.json> --feedback <fix list>`. Do not trust the
builder's own report: run the proof commands yourself.

Then inspect in a fresh session of the provider that did not build, naming who built and the pre-build commit:

```sh
sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" cross-review inspect --host claude --builder <claude|codex> --repo <repo> --plan <plan> --base <pre-build commit>
```

Log findings and dispositions, fix accepted ones, rerun affected proofs, and inspect again in a fresh session. If you
take over coding, you have become a builder: the other provider must inspect your changes, and an earlier inspection
never covers later edits. If both providers wrote code, log who wrote what and have each inspect the other's part.
When the inspection budget runs out, report the remaining findings and the unreviewed edits for the user to decide.

## Close

Present the final diff, proof results, inspection coverage, unresolved findings, deviations, rounds used,
independence, and the spend (the sum of each result's `usd`). Suggest `/remember <decision> #promote` for a decision
worth keeping beyond this project. Commits, pushes and releases follow the user's existing authorization; running the
loop never implies publishing anything.
