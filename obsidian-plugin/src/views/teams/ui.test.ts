import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgents } from "../../data/agents";
import { teamFrom } from "../../data/teams";
import { TeamsCtx, redirectCommand, talkCommand, since, postTime } from "./ui";

// Host parity for the tab's terminal buttons (spec 2026-09-28-agent-teams-design §5): each enabled host gets its own
// command, and a Redirect still reaches a session that can record it when the lead's agent is missing on that host.
const TEAM = teamFrom({
  id: "lab", disabled: false, markers: [], state: null, channel: null, runs: null,
  teamMd: "---\nid: lab\nlead: lead\ngates: [discuss]\nmembers:\n  - id: lead\n    agent: team-lead\n  - id: builder\n    agent: team-builder\n---\n",
  board: JSON.stringify({ id: "site-01", title: "Landing page", stage: "discuss", status: "gate", gate: { name: "discuss", state: "pending" }, ts: "2026-09-20T12:45:00.000Z" }) + "\n",
});
const IT = TEAM.board[0];

function ctx(agents: unknown[]): TeamsCtx {
  return { agents: parseAgents(JSON.stringify({ schema: 1, agents })), hosts: ["codex"] } as unknown as TeamsCtx;
}
const LEAD_BOTH = { id: "team-lead", name: "team-lead", on: {
  claude: { invoke: "@agent-team-lead", run: "claude --agent team-lead" },
  codex: { invoke: "team-lead", run: "codex 'Use the team-lead agent. Ask me what it should work on.'" },
} };

test("Codex: Redirect asks for the lead's agent by name, with the gate and the exact record line", () => {
  const cmd = redirectCommand(ctx([LEAD_BOTH]), TEAM, IT, "codex");
  assert.match(cmd, /^codex 'Use the team-lead agent for this\. The user is redirecting the Discuss gate on site-01 \(Landing page\) in the lab team\./);
  assert.match(cmd, /aos team gate redirect lab site-01 --expect '\\''\{"ts":"2026-09-20T12:45:00\.000Z"\}'\\'' --note/);
  assert.match(redirectCommand(ctx([LEAD_BOTH]), TEAM, IT, "claude"), /^claude --agent team-lead 'The user is redirecting/);
});

test("a host without the lead's agent still gets a Redirect: a plain session with the same prompt", () => {
  const claudeOnly = { ...LEAD_BOTH, on: { claude: LEAD_BOTH.on.claude } };
  assert.match(redirectCommand(ctx([claudeOnly]), TEAM, IT, "codex"), /^codex 'The user is redirecting the Discuss gate on site-01/);
  assert.match(redirectCommand(ctx([]), TEAM, IT, "claude"), /^claude 'The user is redirecting/);
});

test("Talk has no fallback: a member whose agent a host lacks gets no button there", () => {
  assert.equal(talkCommand(ctx([LEAD_BOTH]), "team-builder", "codex"), null);
  assert.equal(talkCommand(ctx([LEAD_BOTH]), "team-lead", "codex"), LEAD_BOTH.on.codex.run);
});

test("ages and post times", () => {
  const now = new Date("2026-09-28T12:00:00.000Z");
  assert.deepEqual([since("2026-09-28T11:48:00.000Z", now), since("2026-09-28T09:00:00.000Z", now), since("2026-09-20T12:00:00.000Z", now), since(null, now)], ["12m", "3h", "8d", "?"]);
  assert.match(postTime("2026-09-20T12:00:00.000Z", now), /^09-20 \d\d:\d\d$/);
  assert.match(postTime(now.toISOString(), now), /^\d\d:\d\d$/);
});
