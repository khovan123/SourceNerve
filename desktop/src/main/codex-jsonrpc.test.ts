import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { CodexJsonRpcConnection } from "./codex-jsonrpc";

describe("CodexJsonRpcConnection", () => {
  it("correlates JSONL responses and streams notifications", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const notifications: Array<{ method: string; params: unknown }> = [];
    const connection = new CodexJsonRpcConnection({
      readable: fromServer,
      writable: toServer,
      onNotification: (method, params) => notifications.push({ method, params }),
    });

    const request = connection.request("thread/start", { cwd: "/tmp/repo" });
    const outgoing = await readJsonLine(toServer);
    expect(outgoing).toMatchObject({ jsonrpc: "2.0", id: 1, method: "thread/start", params: { cwd: "/tmp/repo" } });

    fromServer.write(`${JSON.stringify({ jsonrpc: "2.0", method: "thread/started", params: { thread: { id: "t-1" } } })}\n`);
    fromServer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { thread: { id: "t-1" } } })}\n`);

    await expect(request).resolves.toEqual({ thread: { id: "t-1" } });
    expect(notifications).toEqual([{ method: "thread/started", params: { thread: { id: "t-1" } } }]);
  });

  it("rejects pending requests with the app-server JSON-RPC error", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const connection = new CodexJsonRpcConnection({ readable: fromServer, writable: toServer });

    const request = connection.request("thread/resume", { threadId: "missing" });
    await readJsonLine(toServer);
    fromServer.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "no rollout found" } })}\n`);

    await expect(request).rejects.toMatchObject({ code: -32600, message: "no rollout found" });
  });

  it("fails closed on server requests not implemented by the thin P1 host", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    new CodexJsonRpcConnection({ readable: fromServer, writable: toServer });

    fromServer.write(`${JSON.stringify({ jsonrpc: "2.0", id: "approval-1", method: "item/tool/call", params: { tool: "dynamic" } })}\n`);
    const outgoing = await readJsonLine(toServer);
    expect(outgoing).toEqual({
      jsonrpc: "2.0",
      id: "approval-1",
      error: {
        code: -32601,
        message: "SourceNerve P1 does not implement app-server request item/tool/call",
      },
    });
  });
});

async function readJsonLine(stream: PassThrough): Promise<Record<string, unknown>> {
  const line = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer | string) => {
      stream.off("data", onData);
      resolve(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    stream.on("data", onData);
  });
  return JSON.parse(line.trim()) as Record<string, unknown>;
}
