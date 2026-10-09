import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { DesktopControlBridge, DesktopControlState } from "./desktop-control-bridge";
import type { McpExtensionClient } from "./mcp-extension-client";

const EXTENSION_ID = "sourcenerve-desktop-control";
const EXTENSION_NAME = "SourceNerve Desktop Control";
const EXTENSION_NAMESPACE = "desktop-control";
const EXTENSION_SOURCE = "builtin://sourcenerve/desktop-control";
const EXTENSION_CREDENTIAL_REF = `mcp-extension:${EXTENSION_ID}:credential`;
const MAX_REQUEST_BYTES = 256 * 1024;
const MCP_PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_RECONCILE_INTERVAL_MS = 15_000;

type ToolApproval = "automatic" | "ask";

type DesktopControlToolName =
  | "get_desktop_state"
  | "get_screens"
  | "list_native_applications"
  | "launch_native_application"
  | "get_screenshot"
  | "get_clipboard_text"
  | "set_clipboard_text"
  | "move_mouse"
  | "click_screen"
  | "press_key"
  | "type_text";

interface ToolDefinition {
  name: DesktopControlToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  approval: ToolApproval;
  available(state: DesktopControlState): boolean;
}

interface RegisteredExtensionView {
  id: string;
  version?: string;
  namespace?: string;
  source?: string;
  enabled?: boolean;
  auth_type?: string;
  credential_materialized?: boolean;
  transport?: { transport?: string; url?: string };
}

interface RegisteredToolView {
  original_name?: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "get_desktop_state",
    description: "Get the current SourceNerve desktop-control permissions, available actions, and input backend.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readAnnotations("Get desktop control state"),
    approval: "automatic",
    available: (state) => state.availableActions.length > 0,
  },
  {
    name: "get_screens",
    description: "List desktop screens/windows that SourceNerve may observe. Does not include screenshot pixels.",
    inputSchema: {
      type: "object",
      properties: { maxSources: { type: "integer", minimum: 1, maximum: 20 } },
      additionalProperties: false,
    },
    annotations: readAnnotations("List desktop screens"),
    approval: "automatic",
    available: (state) => state.availableActions.includes("observe"),
  },
  {
    name: "list_native_applications",
    description: "List installed native desktop applications that SourceNerve can launch. Use this when the user asks for a desktop/native app; do not substitute a browser/web equivalent.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 128, description: "Optional case-insensitive app name/id filter." },
        maxApplications: { type: "integer", minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    annotations: readAnnotations("List native desktop applications"),
    approval: "automatic",
    available: (state) => state.availableActions.includes("applications-list"),
  },
  {
    name: "launch_native_application",
    description: "Launch one installed native desktop application by the exact applicationId returned by list_native_applications. Never use this tool with an invented shell command or web URL.",
    inputSchema: {
      type: "object",
      properties: {
        applicationId: { type: "string", minLength: 1, maxLength: 512 },
      },
      required: ["applicationId"],
      additionalProperties: false,
    },
    annotations: writeAnnotations("Launch native desktop application", false),
    approval: "ask",
    available: (state) => state.availableActions.includes("application-launch"),
  },
  {
    name: "get_screenshot",
    description: "Capture a desktop display through Electron desktopCapturer after explicit screen permission. Defaults to the primary display.",
    inputSchema: {
      type: "object",
      properties: {
        displayId: { type: "string", minLength: 1, maxLength: 128, description: "Optional display id returned by get_screens." },
      },
      additionalProperties: false,
    },
    annotations: readAnnotations("Capture desktop screenshot"),
    approval: "automatic",
    available: (state) => state.availableActions.includes("screenshot"),
  },
  {
    name: "get_clipboard_text",
    description: "Read text from the desktop clipboard after explicit clipboard permission.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: readAnnotations("Read desktop clipboard"),
    approval: "automatic",
    available: (state) => state.availableActions.includes("clipboard-read"),
  },
  {
    name: "set_clipboard_text",
    description: "Write bounded text to the desktop clipboard after explicit clipboard permission.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 16384 } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: writeAnnotations("Write desktop clipboard", true),
    approval: "ask",
    available: (state) => state.availableActions.includes("clipboard-write"),
  },
  {
    name: "move_mouse",
    description: "Move the desktop pointer to pixel coordinates in the most recent get_screenshot image through the configured native input backend.",
    inputSchema: coordinateSchema(),
    annotations: writeAnnotations("Move desktop pointer", false),
    approval: "ask",
    available: (state) => state.availableActions.includes("mouse-move"),
  },
  {
    name: "click_screen",
    description: "Move and left-click at pixel coordinates in the most recent get_screenshot image through the configured native input backend.",
    inputSchema: coordinateSchema(),
    annotations: writeAnnotations("Click desktop screen", false),
    approval: "ask",
    available: (state) => state.availableActions.includes("mouse-click"),
  },
  {
    name: "press_key",
    description: "Press one bounded key or key combination through the configured native keyboard backend.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string", minLength: 1, maxLength: 64 } },
      required: ["key"],
      additionalProperties: false,
    },
    annotations: writeAnnotations("Press desktop key", false),
    approval: "ask",
    available: (state) => state.availableActions.includes("key-press"),
  },
  {
    name: "type_text",
    description: "Type bounded text through the configured native keyboard backend.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 16384 } },
      required: ["text"],
      additionalProperties: false,
    },
    annotations: writeAnnotations("Type desktop text", false),
    approval: "ask",
    available: (state) => state.availableActions.includes("type-text"),
  },
];

export class DesktopControlMcpServer {
  private server: Server | null = null;
  private endpoint = "";
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private readonly credential = randomBytes(32).toString("base64url");
  private readonly options: {
    bridge: DesktopControlBridge;
    client: McpExtensionClient;
    version: string;
    reconcileIntervalMs?: number;
    onReconcileError?: (error: unknown) => void;
  };

  constructor(options: {
    bridge: DesktopControlBridge;
    client: McpExtensionClient;
    version: string;
    reconcileIntervalMs?: number;
    onReconcileError?: (error: unknown) => void;
  }) {
    this.options = options;
  }

  async start(): Promise<string> {
    if (this.server) return this.endpoint;
    const server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Desktop-control MCP server did not bind a TCP address");
    }
    this.server = server;
    this.endpoint = `http://127.0.0.1:${address.port}/mcp`;
    this.startReconciler();
    return this.endpoint;
  }

  async reconcile(): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise;
    const pending = this.reconcileInternal().finally(() => {
      if (this.reconcilePromise === pending) this.reconcilePromise = null;
    });
    this.reconcilePromise = pending;
    return pending;
  }

  private async reconcileInternal(): Promise<void> {
    if (!this.server || !this.endpoint) throw new Error("Desktop-control MCP server is not running");
    const state = await this.options.bridge.state();
    const operational = TOOL_DEFINITIONS.some((tool) => tool.name !== "get_desktop_state" && tool.available(state));
    let existing = findExtension(await this.options.client.list());
    if (existing && !this.matchesRegistration(existing)) {
      if (existing.namespace !== EXTENSION_NAMESPACE || existing.source !== EXTENSION_SOURCE) {
        throw new Error(`MCP extension id ${EXTENSION_ID} is already owned by another registration`);
      }
      if (existing.enabled) await this.options.client.disable(EXTENSION_ID).catch(() => undefined);
      await this.options.client.remove(EXTENSION_ID);
      existing = undefined;
    }
    if (!existing) {
      await this.options.client.install({
        id: EXTENSION_ID,
        name: EXTENSION_NAME,
        version: this.options.version,
        namespace: EXTENSION_NAMESPACE,
        source: EXTENSION_SOURCE,
        transport: { transport: "streamable-http", url: this.endpoint },
        authType: "bearer",
        required: false,
        updateChannel: "stable",
      }, EXTENSION_CREDENTIAL_REF);
      existing = findExtension(await this.options.client.list());
    }

    if (!operational) {
      if (existing?.enabled) await this.options.client.disable(EXTENSION_ID);
      return;
    }

    if (!existing?.credential_materialized) {
      await this.options.client.materializeCredential(EXTENSION_ID, this.credential);
      existing = findExtension(await this.options.client.list());
    }
    if (!existing?.enabled) await this.options.client.enable(EXTENSION_ID);
    const discovered = parseRegisteredTools(await this.options.client.listTools(EXTENSION_ID));
    const stateNow = await this.options.bridge.state();
    for (const tool of TOOL_DEFINITIONS) {
      if (!discovered.has(tool.name)) continue;
      await this.options.client.updateToolPolicy({
        extensionId: EXTENSION_ID,
        toolName: tool.name,
        enabled: tool.available(stateNow),
        approval: tool.approval,
      });
    }
  }

  async stop(): Promise<void> {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    await this.reconcilePromise?.catch(() => undefined);
    const owned = await this.options.client.list()
      .then((extensions) => findExtension(extensions))
      .catch(() => undefined);
    if (owned && this.matchesRegistration(owned)) {
      await this.options.client.disable(EXTENSION_ID).catch(() => undefined);
    }
    const server = this.server;
    this.server = null;
    this.endpoint = "";
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  url(): string {
    return this.endpoint;
  }

  private startReconciler(): void {
    const intervalMs = this.options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    if (intervalMs <= 0 || this.reconcileTimer) return;
    this.reconcileTimer = setInterval(() => {
      void this.reconcile().catch((error) => this.options.onReconcileError?.(error));
    }, intervalMs);
    this.reconcileTimer.unref?.();
  }

  private matchesRegistration(extension: RegisteredExtensionView): boolean {
    return extension.version === this.options.version
      && extension.namespace === EXTENSION_NAMESPACE
      && extension.source === EXTENSION_SOURCE
      && extension.auth_type === "bearer"
      && extension.transport?.transport === "streamable-http"
      && extension.transport.url === this.endpoint;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.url !== "/mcp") return sendJson(response, 404, { error: "not_found" });
      if (!isLoopbackHost(request.headers.host)) return sendJson(response, 403, { error: "forbidden_host" });
      if (!validBearer(request.headers.authorization, this.credential)) {
        response.setHeader("www-authenticate", "Bearer");
        return sendJson(response, 401, { error: "unauthorized" });
      }
      if (request.method === "DELETE") return sendEmpty(response, 204);
      if (request.method !== "POST") return sendJson(response, 405, { error: "method_not_allowed" });
      const rpc = await readJsonRpc(request);
      if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
        return sendRpcError(response, rpc.id, -32600, "Invalid Request");
      }
      if (rpc.method === "notifications/initialized") return sendEmpty(response, 202);
      if (rpc.method === "ping") return sendRpcResult(response, rpc.id, {});
      if (rpc.method === "initialize") {
        const requestedVersion = asRecord(rpc.params)?.protocolVersion;
        return sendRpcResult(response, rpc.id, {
          protocolVersion: typeof requestedVersion === "string" ? requestedVersion : MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: EXTENSION_ID, version: this.options.version },
        });
      }
      if (rpc.method === "tools/list") {
        return sendRpcResult(response, rpc.id, {
          tools: TOOL_DEFINITIONS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
          })),
        });
      }
      if (rpc.method === "tools/call") {
        const params = asRecord(rpc.params);
        const name = typeof params?.name === "string" ? params.name : "";
        const args = asRecord(params?.arguments) ?? {};
        const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
        if (!definition) return sendRpcError(response, rpc.id, -32602, "Unknown desktop-control tool");
        try {
          const result = await this.callTool(definition.name, args);
          return sendRpcResult(response, rpc.id, toolResult(result, false));
        } catch (error) {
          return sendRpcResult(
            response,
            rpc.id,
            toolResult({ error: error instanceof Error ? error.message : "desktop-control tool failed" }, true),
          );
        }
      }
      return sendRpcError(response, rpc.id, -32601, "Method not found");
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
  }

  private async callTool(name: DesktopControlToolName, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "get_desktop_state":
        return this.options.bridge.state();
      case "get_screens":
        return this.options.bridge.observe({ includeScreenshot: false, maxSources: optionalInteger(args.maxSources) });
      case "list_native_applications":
        return this.options.bridge.listApplications({
          ...(args.query === undefined ? {} : { query: requiredString(args.query, "query", 128) }),
          maxApplications: optionalInteger(args.maxApplications),
        });
      case "launch_native_application":
        return this.options.bridge.launchApplication(requiredString(args.applicationId, "applicationId", 512));
      case "get_screenshot":
        return this.options.bridge.run({
          action: "screenshot",
          ...(args.displayId === undefined ? {} : { displayId: requiredString(args.displayId, "displayId", 128) }),
        });
      case "get_clipboard_text":
        return this.options.bridge.run({ action: "clipboard-read" });
      case "set_clipboard_text":
        return this.options.bridge.run({ action: "clipboard-write", text: requiredString(args.text, "text", 16 * 1024) });
      case "move_mouse":
        return this.options.bridge.run({ action: "mouse-move", x: requiredCoordinate(args.x, "x"), y: requiredCoordinate(args.y, "y"), coordinateSpace: "last-screenshot" });
      case "click_screen":
        return this.options.bridge.run({ action: "mouse-click", x: requiredCoordinate(args.x, "x"), y: requiredCoordinate(args.y, "y"), coordinateSpace: "last-screenshot" });
      case "press_key":
        return this.options.bridge.run({ action: "key-press", key: requiredString(args.key, "key", 64) });
      case "type_text":
        return this.options.bridge.run({ action: "type-text", text: requiredString(args.text, "text", 16 * 1024) });
    }
  }
}

function readAnnotations(title: string): ToolDefinition["annotations"] {
  return { title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
}

function writeAnnotations(title: string, idempotent: boolean): ToolDefinition["annotations"] {
  return { title, readOnlyHint: false, destructiveHint: false, idempotentHint: idempotent, openWorldHint: true };
}

function coordinateSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      x: { type: "integer", minimum: 0, maximum: 100000, description: "Horizontal pixel coordinate in the most recent get_screenshot image." },
      y: { type: "integer", minimum: 0, maximum: 100000, description: "Vertical pixel coordinate in the most recent get_screenshot image." },
    },
    required: ["x", "y"],
    additionalProperties: false,
  };
}

function findExtension(value: unknown): RegisteredExtensionView | undefined {
  if (!Array.isArray(value)) throw new Error("MCP extension list response is invalid");
  return value.find((item): item is RegisteredExtensionView => {
    const candidate = asRecord(item);
    return candidate?.id === EXTENSION_ID;
  });
}

function parseRegisteredTools(value: unknown): Set<string> {
  if (!Array.isArray(value)) throw new Error("Desktop-control MCP tool response is invalid");
  const names = new Set<string>();
  for (const item of value) {
    const record = item as RegisteredToolView;
    if (typeof record?.original_name === "string") names.add(record.original_name);
  }
  return names;
}

function toolResult(value: unknown, isError: boolean): Record<string, unknown> {
  const screenshot = screenshotResult(value);
  if (screenshot) {
    const { dataUrl, ...metadata } = screenshot.result;
    const prefix = "data:image/png;base64,";
    if (!dataUrl.startsWith(prefix)) throw new Error("Desktop screenshot payload is not a PNG data URL");
    const structured = { ...screenshot.root, result: metadata };
    return {
      content: [
        { type: "image", data: dataUrl.slice(prefix.length), mimeType: "image/png" },
        { type: "text", text: JSON.stringify(structured) },
      ],
      structuredContent: structured,
      isError,
    };
  }
  const structured = asRecord(value) ?? { value };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: structured,
    isError,
  };
}

function screenshotResult(value: unknown): { root: Record<string, unknown>; result: Record<string, unknown> & { dataUrl: string } } | null {
  const root = asRecord(value);
  const result = asRecord(root?.result);
  if (!root || !result || typeof result.dataUrl !== "string" || result.mimeType !== "image/png") return null;
  return { root, result: result as Record<string, unknown> & { dataUrl: string } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? Number(value) : undefined;
}

function requiredCoordinate(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 100000) {
    throw new Error(`Desktop ${label} coordinate is invalid`);
  }
  return Number(value);
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error(`Desktop ${label} value is invalid`);
  }
  return value;
}

function validBearer(value: string | undefined, expected: string): boolean {
  if (!value?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(value.slice("Bearer ".length), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  const host = value.toLowerCase();
  return host === "127.0.0.1" || host.startsWith("127.0.0.1:") || host === "localhost" || host.startsWith("localhost:");
}

async function readJsonRpc(request: IncomingMessage): Promise<JsonRpcRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("Desktop-control MCP request is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) throw new Error("Desktop-control MCP request body is empty");
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  const record = asRecord(value);
  if (!record) throw new Error("Desktop-control MCP request must be a JSON object");
  return record as JsonRpcRequest;
}

function sendRpcResult(response: ServerResponse, id: JsonRpcRequest["id"], result: unknown): void {
  sendJson(response, 200, { jsonrpc: "2.0", id: id ?? null, result });
}

function sendRpcError(response: ServerResponse, id: JsonRpcRequest["id"], code: number, message: string): void {
  sendJson(response, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "cache-control": "no-store" });
  response.end();
}
