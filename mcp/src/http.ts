// Streamable-HTTP transport entry. Stateless: a fresh server + transport is
// created per POST request (no session store), which is simple and safe for
// agent fleets hitting the endpoint concurrently. The endpoint is /mcp.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./server.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function runHttp(configPath?: string, portArg?: number): Promise<void> {
  const port = portArg ?? Number(process.env.PORT ?? process.env.MCP_HTTP_PORT ?? 8820);
  // Build once to report tool count + validate config at boot.
  const boot = buildServer(configPath);
  console.error(
    `blockle-mcp (http) on :${port}/mcp — ${boot.toolNames.length} tools; node=${boot.config.nodeUrl} ` +
      `exchange=${boot.config.exchangeUrl ?? "-"} x402=${boot.config.x402Url ?? "-"}`,
  );

  const httpServer = createServer(async (req, res) => {
    if (!req.url) return json(res, 404, { error: "no url" });
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/health") {
      return json(res, 200, { ok: true, tools: boot.toolNames.length });
    }

    if (url.pathname !== "/mcp") {
      return json(res, 404, { error: "not found; POST JSON-RPC to /mcp" });
    }

    // Stateless streamable-HTTP: GET/DELETE have no session to serve.
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. This stateless endpoint accepts POST only." },
          id: null,
        }),
      );
    }

    try {
      const body = await readBody(req);
      // Fresh server + transport per request (stateless).
      const { server } = buildServer(configPath);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("mcp http error:", err);
      if (!res.headersSent) {
        json(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
          id: null,
        });
      }
    }
  });

  httpServer.listen(port);
}
