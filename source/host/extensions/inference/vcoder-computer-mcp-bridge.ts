import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  createComputerTool,
  createScreenshotTool,
  type ComputerToolDependencies,
} from "../../runner/tools/sand-computer-tool.js";

// A per-turn, loopback-only MCP server that hands the vcoder CLI the same
// Screenshot/Computer tools the cursor path gets from sand-computer-tool.ts,
// routed through the same box computer-use executor (createHostComputerToolDependencies).
// Modeled on node-agent-coordinator/routed-mcp-bridge.ts: JSON-RPC over a
// single-use POST path keyed by a random secret, tools/list + tools/call only.

function record(value: unknown): Record<string, any> | null {
  return typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, any> : null;
}

export async function createVcoderComputerMcpBridge<Context>(
  deps: ComputerToolDependencies<Context>,
  context: Context,
): Promise<{ readonly url: string; close(): Promise<void> }> {
  const secret = randomUUID();
  const screenshotTool = createScreenshotTool(deps);
  const computerTool = createComputerTool(deps);
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
        reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "sand-computer-use", version: "1" } });
        return;
      }
      if (message.method === "tools/list") {
        reply({
          tools: [
            {
              name: "screenshot",
              description: "Capture a screenshot of the box's virtual desktop so you can see what's currently on screen before deciding where to click or type.",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
            },
            {
              name: "computer",
              description: "Operate the box's virtual desktop like a human would: click, move, drag, type, press keys, scroll, or wait, by pixel coordinate. Always look at a recent screenshot first. A screenshot is captured automatically after every action.",
              inputSchema: zodToJsonSchema(computerTool.parameters),
              annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
            },
          ],
        });
        return;
      }
      if (message.method === "tools/call") {
        const params = record(message.params);
        const name = params?.name;
        const args = params?.arguments ?? {};
        const toolCallId = randomUUID();
        if (name === "screenshot") {
          const result = await screenshotTool.execute({}, { context, toolCallId });
          reply({ content: [{ type: "text", text: screenshotTool.render(result).content }] });
          return;
        }
        if (name === "computer") {
          const result = await computerTool.execute(args, { context, toolCallId });
          reply({ content: [{ type: "text", text: computerTool.render(result).content }] });
          return;
        }
        reply({ isError: true, content: [{ type: "text", text: `Unknown computer-use tool: ${String(name)}` }] });
        return;
      }
      reply({});
    } catch (error) {
      reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address == null || typeof address === "string") throw new Error("Could not bind the vcoder computer-use MCP bridge");
  return {
    url: `http://127.0.0.1:${address.port}/mcp/${secret}`,
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error == null ? resolve() : reject(error)); }),
  };
}
