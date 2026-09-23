# Build and final inspection

The commands are in the skill's Phase 3. This reference covers what has to hold around them. Carry the exact
acceptance criteria and proof commands from the plan into the build, and keep the toolchains the user chose.

## Preparation

Capture the pre-build commit before changing any code. For a new project, set up an initial git baseline with the
user's authorization; never claim a full git diff without one. A build by the host may keep existing changes and
account for them. A delegated build needs an isolated, clean checkout: use a worktree for unrelated or live changes,
never stash another session's work, and do not create commits just to pass the gate without authorization.

The runner refuses a delegated build in a dirty checkout. Plan and log files written by the loop can make it dirty
themselves: keep them outside the build checkout, or include them in an authorised baseline. When moving to a
worktree, review the copied plan again there before using its approval, because an approval is bound to the repository
path. Resolve source paths against the build worktree so the builder cannot touch the original checkout. A worktree
isolates diffs; it is not an operating-system sandbox.

## Delegated build

The Codex builder runs in its `workspace-write` sandbox with approvals off; the Claude builder runs with the user's
normal permissions in `acceptEdits` mode, so a command that still needs approval is denied, not bypassed. Confirm that
the proof commands are permitted before launching. Never answer a denial by switching permissions off. If the builder
cannot do some required work, report it, or have the already-authorised host do that part and log the authorship.

A standalone work order the user asked for without plan review uses `--unreviewed-spec` in place of `--approval`;
record the missing review. It never waives the inspection of the final code.

Fix rounds pass the previous build result as `--prior`. The clean-checkout gate applies only to the first build; later
rounds must stay on the same recorded baseline, and the host makes sure any intervening change belongs to this build.
The build result's `base` is the initial commit. A builder's success report or proof output is not independent
verification.

## Verify and inspect

Read every change relative to the pre-build commit: staged changes, deletions, binary files and untracked files. For
changed tests, check that the assertions express the acceptance criteria or a valid regression, rather than just
confirming whatever the implementation does; an existing necessary regression test need not map to a new plan
sentence. Run the agreed proof commands yourself, and add manual or visual checks when the deliverable calls for them.

The inspection receives the tracked diff and a manifest of every changed and untracked file, and the reviewer is told to
open the added files. The runner fingerprints the inspected state and refuses a result if the code changes during the
inspection. Git does not list ignored files: inspect ignored build outputs separately. A changed submodule needs an
explicit inspection path rather than a silently incomplete diff.

Log findings, coverage, limitations and dispositions. Fix accepted findings, rerun the affected proofs, then inspect
again in a fresh session of the other provider. An inspection covers its recorded snapshot only; later edits invalidate
it. If the host takes over, the inspector is the provider opposite the new builder. For mixed authorship, log the split
and have each provider inspect the other's changes; disclose remaining gaps when the round budget runs out.

Stop at the fix and inspection budgets and report unresolved findings rather than claiming approval. An explicit
`inspect=off` stays a logged opt-out. The final report names the proof, the inspected snapshot, deviations, residual
findings and any unreviewed edits.
