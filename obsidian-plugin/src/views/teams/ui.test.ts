import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAgents } from "../../data/agents";
import { teamFrom, teamCommand, envPrefix, redirectPrompt, expectOf, shq } from "../../data/teams";
import { TeamsCtx, redirectCommand, talkCommand, since, postTime } from "./ui";
import { addable } from "./ManagePane";

// Host parity for the tab's terminal buttons (spec 2026-09-28-agent-teams-design §5): each enabled host gets its own
// command, and a Redirect still reaches a session that can record it when the lead's agent is missing on that host.
const TEAM = teamFrom({
  id: "lab", disabled: false, markers: [], state: null, channel: null, runs: null,
  teamMd: "---\nid: lab\nlead: lead\ngates: [discuss]\nmembers:\n  - id: lead\n    agent: team-lead\n  - id: builder\n    agent: team-builder\n---\n",
  board: JSON.stringify({ id: "site-01", title: "Landing page", stage: "discuss", status: "gate", gate: { name: "discuss", state: "pending" }, ts: "2026-09-20T12:45:00.000Z" }) + "\n",
});
const IT = TEAM.board[0];

function ctx(agents: unknown[]): TeamsCtx {
  return { agents: parseAgents(JSON.stringify({ schema: 1, agents })), hosts: ["codex"], teamCmd: "aos team", hostEnv: { claude: "", codex: "" } } as unknown as TeamsCtx;
}
const LEAD_BOTH = { id: "team-lead", name: "team-lead", on: {
  claude: { invoke: "@agent-team-lead", run: "claude --agent team-lead" },
  codex: { invoke: "team-lead", run: "codex 'Use the team-lead agent. Ask me what it should work on.'" },
} };

test("Codex: Redirect asks for the lead's agent by name, with the gate and the exact record line", () => {
  const cmd = redirectCommand(ctx([LEAD_BOTH]), TEAM, IT, "codex");
  assert.match(cmd, /^codex 'Use the team-lead agent for this\. The user is redirecting the Discuss gate on site-01 \(Landing page\) in the lab team\./);
  assert.ok(cmd.endsWith(shq(`Use the team-lead agent for this. ${redirectPrompt(TEAM, IT)}`)));
  assert.ok(redirectPrompt(TEAM, IT).includes(`aos team gate redirect 'lab' 'site-01' --expect ${shq(expectOf(IT))} --note`));
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

test("Add a member offers only agents member add can find: its file carries the agent's name", () => {
  const [a, b, c] = parseAgents(JSON.stringify({ schema: 1, agents: [
    { id: "team-scout", name: "team-scout", origin: { host: "claude", scope: "user", path: "/x/agents/team-scout.md" }, on: { claude: { invoke: "@agent-team-scout", path: "/x/agents/team-scout.md", run: "claude --agent team-scout" } } },
    { id: "reviewer", name: "reviewer", origin: { host: "claude", scope: "user", path: "/x/agents/my-reviewer.md" }, on: { claude: { invoke: "@agent-reviewer", path: "/x/agents/my-reviewer.md", run: "claude --agent reviewer" } } },
    { id: "ops-bot", name: "ops-bot", origin: { host: "codex", scope: "user", path: "/y/agents/ops-bot.toml" }, on: { codex: { invoke: "ops-bot", path: "/y/agents/ops-bot.toml", run: "codex 'Use the ops-bot agent.'" } } },
  ] })).agents;
  assert.deepEqual([addable(a), addable(b), addable(c)], [true, false, true]);
});

test("a session records into the vault the tab shows, with each host's folder the plugin uses", () => {
  assert.equal(teamCommand("/v/two", "/opt/node"), "AOS_VAULT='/v/two' '/opt/node' '/v/two/brain/scripts/team.js'", "never the terminal's own aos config");
  assert.equal(envPrefix("CLAUDE_CONFIG_DIR", "/h/.claude", "/h/.claude/"), "");
  assert.equal(envPrefix("CLAUDE_CONFIG_DIR", "/h/work-claude", "/h/.claude"), "CLAUDE_CONFIG_DIR='/h/work-claude' ");
  assert.equal(envPrefix("CODEX_HOME", "/h/work-codex", "/h/.codex"), "CODEX_HOME='/h/work-codex' ");
  const c = { ...ctx([LEAD_BOTH]), hosts: ["claude", "codex"], teamCmd: teamCommand("/v/two", "/opt/node"),
    hostEnv: { claude: "CLAUDE_CONFIG_DIR='/h/work-claude' ", codex: "CODEX_HOME='/h/work-codex' " } } as TeamsCtx;
  const prompt = redirectPrompt(TEAM, IT, c.teamCmd);
  assert.ok(prompt.includes("AOS_VAULT='/v/two' '/opt/node' '/v/two/brain/scripts/team.js' gate redirect 'lab' 'site-01'"));
  assert.equal(redirectCommand(c, TEAM, IT, "claude"), `CLAUDE_CONFIG_DIR='/h/work-claude' claude --agent team-lead ${shq(prompt)}`);
  assert.equal(redirectCommand(c, TEAM, IT, "codex"), `CODEX_HOME='/h/work-codex' codex ${shq(`Use the team-lead agent for this. ${prompt}`)}`);
  assert.equal(talkCommand(c, "team-lead", "claude"), "CLAUDE_CONFIG_DIR='/h/work-claude' claude --agent team-lead");
  assert.equal(talkCommand(c, "team-lead", "codex"), `CODEX_HOME='/h/work-codex' ${LEAD_BOTH.on.codex.run}`);
  assert.equal(redirectCommand({ ...c, agents: parseAgents("{}") } as TeamsCtx, TEAM, IT, "codex"), `CODEX_HOME='/h/work-codex' codex ${shq(prompt)}`);
});
