#!/usr/bin/env node
// customWhispr meeting-coach connector for Claude Desktop / Cowork.
//
// A stdio MCP server with no dependencies. Claude Desktop launches it (see
// claude_desktop_config.json); it forwards tool calls to the running
// customWhispr app over 127.0.0.1, authenticated with the token the app
// writes to {userData}/coach-connector.json. Runs fine under the app's own
// Electron binary with ELECTRON_RUN_AS_NODE=1, so no separate Node install
// is needed.

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const readline = require("readline");

const SERVER_INFO = { name: "customwhispr", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2025-06-18";
const CALL_TIMEOUT_MS = 30000;

const TOOLS = JSON.parse(fs.readFileSync(path.join(__dirname, "tools.json"), "utf8"));

function connectorInfoPath() {
  if (process.env.CUSTOMWHISPR_CONNECTOR_FILE) return process.env.CUSTOMWHISPR_CONNECTOR_FILE;
  return path.join(os.homedir(), "Library", "Application Support", "custom-whispr", "coach-connector.json");
}

function readConnectorInfo() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(connectorInfoPath(), "utf8"));
  } catch {
    throw new Error("customWhispr isn't running (or hasn't been opened since the connector was installed). Open customWhispr and try again.");
  }
  if (!info.port || !info.token) throw new Error("customWhispr connector file is incomplete — restart customWhispr.");
  return info;
}

function callApp(tool, args) {
  const { port, token } = readConnectorInfo();
  const body = JSON.stringify({ tool, args });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/call",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${token}`,
        },
        timeout: CALL_TIMEOUT_MS,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let parsed;
          try {
            parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            reject(new Error(`customWhispr returned an unreadable response (HTTP ${res.statusCode})`));
            return;
          }
          if (res.statusCode === 401) {
            reject(new Error("customWhispr rejected the connector token — restart customWhispr."));
          } else if (parsed.error) {
            reject(new Error(parsed.error));
          } else {
            resolve(parsed.result);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("customWhispr did not respond in time")));
    req.on("error", (err) => {
      reject(
        err.code === "ECONNREFUSED"
          ? new Error("customWhispr isn't running. Open customWhispr and try again.")
          : err
      );
    });
    req.end(body);
  });
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize":
        return isRequest &&
          send({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL,
              capabilities: { tools: {} },
              serverInfo: SERVER_INFO,
              instructions:
                "customWhispr records the user's meetings and coaches them live. Use list_meetings to find a meeting, set_meeting_prep to load a prep checklist + stance before a call, and get_meeting_transcript / get_coaching_summary afterwards.",
            },
          });
      case "ping":
        return isRequest && send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      case "tools/call": {
        const name = params?.name;
        if (!TOOLS.some((t) => t.name === name)) {
          return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        }
        try {
          const result = await callApp(name, params?.arguments || {});
          return send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
          });
        } catch (err) {
          // Tool-level failures are results, so the model can read and react
          return send({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: err.message }], isError: true },
          });
        }
      }
      default:
        if (isRequest) {
          send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
        }
        return undefined;
    }
  } catch (err) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
    return undefined;
  }
}

// In-flight requests must finish before exit — a client that writes its
// requests and closes stdin would otherwise never get the responses
const pending = new Set();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }
  const task = handle(message).finally(() => pending.delete(task));
  pending.add(task);
});
rl.on("close", async () => {
  await Promise.allSettled([...pending]);
  process.exit(0);
});
