import type {
  McpExtensionInstallInput,
  McpExtensionToolPolicyInput,
} from "../shared/mcp-extension-api";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface McpExtensionClientOptions {
  baseUrl: string;
  getBearer(): Promise<string>;
}

export class McpExtensionClient {
  private readonly baseUrl: URL;
  private readonly getBearer: () => Promise<string>;

  constructor(options: McpExtensionClientOptions) {
    const baseUrl = new URL(options.baseUrl);
    if (baseUrl.protocol !== "http:" || !isLoopbackHostname(baseUrl.hostname)) {
      throw new Error("MCP extension Desktop client requires a loopback SourceNerve URL");
    }
    if (baseUrl.hostname === "localhost") baseUrl.hostname = "127.0.0.1";
    this.baseUrl = baseUrl;
    this.getBearer = options.getBearer;
  }

  list(): Promise<unknown> {
    return this.request("/api/v1/mcp/extensions", { method: "GET" });
  }

  install(input: McpExtensionInstallInput, secretRef?: string): Promise<unknown> {
    return this.request("/api/v1/mcp/extensions/register", {
      method: "POST",
      body: {
        id: input.id,
        name: input.name,
        version: input.version,
        namespace: input.namespace,
        source: input.source,
        transport: input.transport,
        auth_type: input.authType,
        ...(secretRef ? { secret_ref: secretRef } : {}),
        required: Boolean(input.required),
        update_channel: input.updateChannel ?? "stable",
      },
    });
  }

  enable(extensionId: string): Promise<unknown> {
    return this.postId("/api/v1/mcp/extensions/enable", extensionId);
  }

  disable(extensionId: string): Promise<unknown> {
    return this.postId("/api/v1/mcp/extensions/disable", extensionId);
  }

  restart(extensionId: string): Promise<unknown> {
    return this.postId("/api/v1/mcp/extensions/restart", extensionId);
  }

  remove(extensionId: string): Promise<unknown> {
    return this.postId("/api/v1/mcp/extensions/remove", extensionId);
  }

  listTools(extensionId: string): Promise<unknown> {
    return this.postId("/api/v1/mcp/extensions/tools", extensionId);
  }

  updateToolPolicy(input: McpExtensionToolPolicyInput): Promise<unknown> {
    return this.request("/api/v1/mcp/extensions/tools/policy", {
      method: "POST",
      body: {
        extension_id: input.extensionId,
        tool_name: input.toolName,
        enabled: input.enabled,
        approval: input.approval,
      },
    });
  }

  materializeCredential(extensionId: string, credential: string): Promise<unknown> {
    return this.request("/api/v1/mcp/extensions/credential/materialize", {
      method: "POST",
      body: { extension_id: extensionId, credential },
    });
  }

  clearCredential(extensionId: string): Promise<unknown> {
    return this.postId("/api/v1/mcp/extensions/credential/clear", extensionId);
  }

  approveNext(publicTool: string): Promise<unknown> {
    return this.request("/api/v1/mcp/extensions/approve-next", {
      method: "POST",
      body: { public_tool: publicTool },
    });
  }

  health(): Promise<unknown> {
    return this.request("/api/v1/mcp/extensions/health", { method: "GET" });
  }

  private postId(path: string, extensionId: string): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      body: { extension_id: extensionId },
    });
  }

  private async request(
    path: string,
    options: { method: "GET" | "POST"; body?: object },
  ): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin) {
      throw new Error("MCP extension request escaped the SourceNerve loopback origin");
    }
    const bearer = await this.getBearer();
    if (!bearer || bearer.length > 4096 || !/^[\x21-\x7e]+$/.test(bearer)) {
      throw new Error("SourceNerve local bearer is unavailable");
    }
    const headers = new Headers({
      accept: "application/json",
      authorization: `Bearer ${bearer}`,
    });
    let body: string | undefined;
    if (options.body) {
      body = JSON.stringify(options.body);
      if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
        throw new Error("MCP extension request exceeds the Desktop size limit");
      }
      headers.set("content-type", "application/json");
    }
    const response = await fetch(url, {
      method: options.method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) {
      const text = await readTextBounded(response, 4096).catch(() => "");
      let detail = `SourceNerve MCP extension API returned HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === "string" && parsed.error.length <= 1024) detail = parsed.error;
      } catch {
        // Keep bounded status message.
      }
      throw new Error(detail);
    }
    const text = await readTextBounded(response, MAX_RESPONSE_BYTES);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("SourceNerve MCP extension API returned invalid JSON");
    }
  }
}

async function readTextBounded(response: Response, limit: number): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) {
    throw new Error("SourceNerve MCP extension response exceeded the Desktop size limit");
  }
  const body = response.body;
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > limit) {
      await reader.cancel().catch(() => undefined);
      throw new Error("SourceNerve MCP extension response exceeded the Desktop size limit");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]" || hostname === "::1";
}
