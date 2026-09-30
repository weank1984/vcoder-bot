import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

// Loopback MCP server exposing Grok Bot's agent-to-agent tools (SendToAgent,
// ListAgents, CreateAgent, UpdateAgent) to the embedded VCoder session. The
// cursor path gets these from turn-toolset; without this bridge a VCoder bot
// only had VCoder's own SendMessage(to=…), which addresses teammates inside
// the VCoder process and always reported "sent to 0 recipients".
// Same shape as vcoder-computer-mcp-bridge.ts: JSON-RPC over a single secret
// POST path, tools/list + tools/call, binding resolved on every call.

export interface VCoderAgentAddress {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface VCoderAgentGroupAddress extends VCoderAgentAddress {
  readonly members: readonly VCoderAgentAddress[];
}

export interface VCoderAgentMessagingBinding {
  readonly selfAgentId: string;
  sendToAgent(targetId: string, message: string, priority: boolean): Promise<string> | string;
  listAgents(): { readonly agents: readonly VCoderAgentAddress[]; readonly groups: readonly VCoderAgentGroupAddress[] };
  createAgent(profile: { readonly name: string; readonly description: string }): Promise<{ readonly id: string; readonly name: string }>;
  updateAgent(id: string, patch: { readonly name?: string; readonly description?: string }): Promise<{ readonly id: string; readonly name: string } | null>;
}

const TOOLS = [
  {
    name: "SendToAgent",
    description: "Send a message to ANOTHER of the user's bots, or post into a GROUP chat you belong to, by its id (not the user — SendUserMessage reaches the user). Fire-and-forget: it wakes the recipient and returns a delivery acknowledgement immediately; it does NOT return their reply. Any reply arrives later as its own message that starts a new turn for you, so do not wait or poll for it. Get ids from ListAgents. Use it only when it serves the user's goal; message several bots or a group only when the user asked you to.",
    inputSchema: {
      type: "object",
      properties: {
        target_id: { type: "string", description: "Id of the target bot or group (from ListAgents), not its name." },
        message: { type: "string", description: "What to say. Lead with the point, keep it short." },
        priority: { type: "boolean", description: "1:1 only: interrupt the recipient's current non-user work. Default false." },
      },
      required: ["target_id", "message"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "ListAgents",
    description: "List the user's other bots and the group chats you belong to, with their ids, for use with SendToAgent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "CreateAgent",
    description: "Create a new bot (teammate assistant) for the user with a name and persona. Returns its id so you can message it with SendToAgent. Only create one when genuinely useful; you cannot delete bots.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short human-readable name." },
        description: { type: "string", description: "Persona / instructions for the new bot." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "UpdateAgent",
    description: "Edit an existing bot's name and/or description. Omitted fields stay unchanged.",
    inputSchema: {
      type: "object",
      properties: {
        agent_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
      },
      required: ["agent_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function line(address: VCoderAgentAddress): string {
  const description = text(address.description);
  return `- ${address.name} (id: ${address.id})${description == null ? "" : ` — ${description.slice(0, 120)}`}`;
}

export async function callVCoderAgentTool(binding: VCoderAgentMessagingBinding, name: unknown, args: Record<string, unknown>): Promise<{ text: string; isError?: true }> {
  if (name === "SendToAgent") {
    const target = text(args.target_id);
    const message = text(args.message);
    if (target == null || message == null) return { text: "SendToAgent needs target_id and message.", isError: true };
    if (target === binding.selfAgentId) return { text: "You can't message yourself with SendToAgent. Use SendUserMessage to talk to the user, or pick a different target id.", isError: true };
    const known = binding.listAgents();
    if (!known.agents.some(agent => agent.id === target) && !known.groups.some(group => group.id === target)) {
      return { text: `No bot or group with id ${target}. Call ListAgents for valid ids (use the id, not the name).`, isError: true };
    }
    const ack = await binding.sendToAgent(target, message, args.priority === true);
    return { text: typeof ack === "string" && ack.length > 0 ? ack : "Delivered." };
  }
  if (name === "ListAgents") {
    const { agents, groups } = binding.listAgents();
    const parts = [
      agents.length === 0 ? "Other bots: none." : `Other bots:\n${agents.map(line).join("\n")}`,
      groups.length === 0 ? "Groups you belong to: none." : `Groups you belong to:\n${groups.map(group => `${line(group)}\n  members: ${group.members.map(member => `${member.name} (${member.id})`).join(", ") || "none"}`).join("\n")}`,
    ];
    return { text: parts.join("\n\n") };
  }
  if (name === "CreateAgent") {
    const agentName = text(args.name);
    if (agentName == null) return { text: "CreateAgent needs a name.", isError: true };
    const created = await binding.createAgent({ name: agentName, description: text(args.description) ?? "" });
    return { text: `Created bot "${created.name}" (id: ${created.id}). Message it with SendToAgent using that id.` };
  }
  if (name === "UpdateAgent") {
    const id = text(args.agent_id);
    if (id == null) return { text: "UpdateAgent needs agent_id.", isError: true };
    const patch = { ...(text(args.name) == null ? {} : { name: text(args.name)! }), ...(text(args.description) == null ? {} : { description: text(args.description)! }) };
    if (Object.keys(patch).length === 0) return { text: "Nothing to update: provide a new name and/or description.", isError: true };
    const updated = await binding.updateAgent(id, patch);
    return updated == null ? { text: `No bot found with id ${id}.`, isError: true } : { text: `Updated bot "${updated.name}" (id: ${updated.id}).` };
  }
  return { text: `Unknown agent tool: ${String(name)}`, isError: true };
}

export async function createVcoderAgentsMcpBridge(
  resolve: () => VCoderAgentMessagingBinding,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const secret = randomUUID();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== `/mcp/${secret}`) { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 1_048_576) { response.writeHead(413).end(); return; }
    }
    let message: Record<string, any>;
    try { message = JSON.parse(body) as Record<string, any>; }
    catch { response.writeHead(400).end(); return; }
    if (message.method === "notifications/initialized") { response.writeHead(202).end(); return; }
    const reply = (result: unknown) => { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
    try {
      if (message.method === "initialize") {
        reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "sand-agents", version: "1" } });
        return;
      }
      if (message.method === "tools/list") { reply({ tools: TOOLS }); return; }
      if (message.method === "tools/call") {
        const params = (message.params ?? {}) as Record<string, any>;
        const args = typeof params.arguments === "object" && params.arguments != null ? params.arguments as Record<string, unknown> : {};
        const result = await callVCoderAgentTool(resolve(), params.name, args);
        reply({ content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) });
        return;
      }
      reply({});
    } catch (error) {
      reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
    }
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Could not bind the vcoder agents MCP bridge");
  return {
    url: `http://127.0.0.1:${address.port}/mcp/${secret}`,
    close: () => new Promise<void>((resolveClose, reject) => { server.closeAllConnections(); server.close(error => error == null ? resolveClose() : reject(error)); }),
  };
}
