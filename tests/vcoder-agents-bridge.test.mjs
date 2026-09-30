import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadModule() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "grok-vcoder-agents-"));
  const output = path.join(temporary, "bridge.mjs");
  await build({
    entryPoints: [path.join(repoRoot, "source/host/extensions/inference/vcoder-agents-mcp-bridge.ts")],
    outfile: output, bundle: true, format: "esm", platform: "node", logLevel: "silent",
  });
  try { return await import(`${pathToFileURL(output).href}?t=${Date.now()}`); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

function fakeBinding() {
  const sent = [];
  return {
    sent,
    binding: {
      selfAgentId: "self",
      sendToAgent: (target, message, priority) => { sent.push({ target, message, priority }); return "Sent to 1 recipient(s)."; },
      listAgents: () => ({
        agents: [{ id: "bot-b", name: "New Bot", description: "helper" }],
        groups: [{ id: "grp", name: "Trip", members: [{ id: "bot-b", name: "New Bot" }] }],
      }),
      createAgent: async ({ name }) => ({ id: "bot-new", name }),
      updateAgent: async (id, patch) => (id === "bot-b" ? { id, name: patch.name ?? "New Bot" } : null),
    },
  };
}

async function rpc(url, method, params) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return (await response.json()).result;
}

test("agents MCP bridge lists tools and delivers SendToAgent to a known bot", async () => {
  const { createVcoderAgentsMcpBridge } = await loadModule();
  const { binding, sent } = fakeBinding();
  const bridge = await createVcoderAgentsMcpBridge(() => binding);
  try {
    const listed = await rpc(bridge.url, "tools/list");
    assert.deepEqual(listed.tools.map(tool => tool.name), ["SendToAgent", "ListAgents", "CreateAgent", "UpdateAgent"]);
    const result = await rpc(bridge.url, "tools/call", { name: "SendToAgent", arguments: { target_id: "bot-b", message: "查一下票价" } });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /1 recipient/);
    assert.deepEqual(sent, [{ target: "bot-b", message: "查一下票价", priority: false }]);
    const group = await rpc(bridge.url, "tools/call", { name: "SendToAgent", arguments: { target_id: "grp", message: "hi all" } });
    assert.equal(group.isError, undefined);
    const roster = await rpc(bridge.url, "tools/call", { name: "ListAgents", arguments: {} });
    assert.match(roster.content[0].text, /New Bot \(id: bot-b\)/);
    assert.match(roster.content[0].text, /Trip \(id: grp\)/);
  } finally { await bridge.close(); }
});

test("agents MCP bridge reports unknown targets and self-messaging as errors", async () => {
  const { callVCoderAgentTool } = await loadModule();
  const { binding, sent } = fakeBinding();
  const unknown = await callVCoderAgentTool(binding, "SendToAgent", { target_id: "New Bot", message: "x" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /ListAgents/);
  const self = await callVCoderAgentTool(binding, "SendToAgent", { target_id: "self", message: "x" });
  assert.equal(self.isError, true);
  assert.equal(sent.length, 0);
  const created = await callVCoderAgentTool(binding, "CreateAgent", { name: "Scout" });
  assert.match(created.text, /id: bot-new/);
});
