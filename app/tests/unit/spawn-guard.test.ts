import { test } from "node:test";
import assert from "node:assert/strict";
import { setWriteGuard } from "../../compat/src/guard";
import { SURFACE_IDS, WritePolicy } from "../../src/shared/write-policy";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const cp = require("../../src/renderer/guard/child_process.cjs") as { __isAllowed(cmd: string, args: string[], opts?: object): boolean };

const VAULT = "/vaults/demo";
const S = `${VAULT}/brain/scripts`;
const NODE = "/opt/homebrew/bin/node";

setWriteGuard(new WritePolicy(VAULT, []));

test("reads and the HUD's background refreshes are allowed", () => {
  for (const args of [
    [`${S}/cli/aos.js`, "config", "list", "--json"],
    [`${S}/cli/aos.js`, "config", "get", "cost.enabled", "--json"],
    [`${S}/cli/aos.js`, "routines", "hosts", "--refresh"],
    [`${S}/cli/aos.js`, "skills", "sync"],
    [`${S}/cli/aos.js`, "agents", "sync"],
    [`${S}/reconcile-sessions.js`],
    [`${S}/statusline.js`, "refresh"],
    [`${S}/scan-vault.js`, "--quiet"],
    [`${S}/scan-vault.js`],
    [`${S}/team.js`, "list", "--json"],
  ]) assert.equal(cp.__isAllowed(NODE, args), true, args.join(" "));
});

test("content writes and user actions stay refused", () => {
  for (const args of [
    [`${S}/cli/aos.js`, "config", "set", "cost.enabled", "true"],
    [`${S}/cli/aos.js`, "routines", "sync"],
    [`${S}/cli/aos.js`, "skills", "include", "x"],
    [`${S}/team.js`, "gate", "dev", "item-1", "approve"],
    [`${S}/team.js`, "list", "--json", "--extra"],
    [`${S}/statusline.js`, "install"],
    [`${S}/cost-budget.js`, "--anchor", "12"],
    [`${S}/routines/run-routine.js`, "tick", "--manual"],
    [`${S}/sdk/ask.js`, "--local", "hi"],
  ]) assert.equal(cp.__isAllowed(NODE, args), false, args.join(" "));
});

test("only node, only this vault's scripts, no path tricks", () => {
  assert.equal(cp.__isAllowed("/bin/sh", [`${S}/scan-vault.js`]), false, "not node");
  assert.equal(cp.__isAllowed("claude", ["-p", "hi"]), false, "not node");
  assert.equal(cp.__isAllowed(NODE, ["/other/vault/brain/scripts/scan-vault.js"]), false, "another vault");
  assert.equal(cp.__isAllowed(NODE, [`${S}/../../evil/scan-vault.js`]), false, "escapes brain/scripts");
  assert.equal(cp.__isAllowed(NODE, ["brain/scripts/scan-vault.js"]), false, "relative path");
  assert.equal(cp.__isAllowed(NODE, ["-e", "require('fs')"]), false, "inline code");
  assert.equal(cp.__isAllowed(NODE, []), false, "no script");
});

test("a shell is never allowed, even for an allowed command", () => {
  assert.equal(cp.__isAllowed(NODE, [`${S}/scan-vault.js`, "--quiet"]), true);
  assert.equal(cp.__isAllowed(NODE, [`${S}/scan-vault.js`, "--quiet"], { shell: true }), false);
  assert.equal(cp.__isAllowed(NODE, [`${S}/scan-vault.js`, "--quiet"], { shell: "/bin/zsh" }), false);
});

test("with every surface on, strangers and shells stay refused", () => {
  setWriteGuard(new WritePolicy(VAULT, [...SURFACE_IDS]));
  try {
    assert.equal(cp.__isAllowed("/bin/sh", ["-c", "true"]), false);
    assert.equal(cp.__isAllowed(NODE, ["-e", "require('fs')"]), false);
    assert.equal(cp.__isAllowed(NODE, [`${S}/../../evil/scan-vault.js`]), false);
    assert.equal(cp.__isAllowed(NODE, [`${S}/cli/aos.js`, "uninstall"]), false);
    assert.equal(cp.__isAllowed(NODE, [`${S}/statusline.js`, "install"]), false);
  } finally { setWriteGuard(new WritePolicy(VAULT, [])); }
});
