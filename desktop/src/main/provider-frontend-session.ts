import { createHash } from "node:crypto";

const MAX_ID_BYTES = 256;

export type ProviderFrontendKind = "chatgpt-web" | "chrome-extension";

export interface ProviderFrontendIdentity {
  provider: ProviderFrontendKind;
  /** Stable hash of the browser document URL/title, not a SourceNerve run id. */
  documentId: string;
  /** Provider conversation id when visible in the URL/extension payload. */
  conversationId?: string;
  /** Logical provider turn id when visible in the DOM/extension payload. */
  turnId?: string;
  /** Monotonic browser-document epoch; increments when the provider document changes. */
  epoch: number;
  /** SourceNerve Chrome extension protocol version when the frontend is extension-backed. */
  extensionProtocolVersion?: number;
}

export interface SourceNerveSessionIdentity {
  sourceSessionId: string;
  runId: string;
  workspace: string;
}

export interface ProviderFrontendBinding {
  source: SourceNerveSessionIdentity;
  frontend: ProviderFrontendIdentity;
  boundAt: number;
  updatedAt: number;
}

export function frontendDocumentId(input: { url: string; title?: string }): string {
  const boundedUrl = boundIdLike(input.url || "about:blank", 4096);
  const boundedTitle = boundIdLike(input.title || "", 512);
  return createHash("sha256").update(`${boundedUrl}\n${boundedTitle}`, "utf8").digest("hex").slice(0, 32);
}

export function parseChatGptConversationId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    for (let index = 0; index < parts.length - 1; index += 1) {
      if (parts[index] === "c" && isSafeProviderId(parts[index + 1])) return parts[index + 1];
    }
    const candidate = parsed.searchParams.get("conversation") || parsed.searchParams.get("conversationId");
    return candidate && isSafeProviderId(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

export function safeProviderTurnId(value: unknown): string | undefined {
  return typeof value === "string" && isSafeProviderId(value) ? value : undefined;
}

export function bindProviderFrontend(input: {
  sourceSessionId: string;
  runId: string;
  workspace: string;
  frontend: ProviderFrontendIdentity;
  now?: number;
}): ProviderFrontendBinding {
  const now = input.now ?? Date.now();
  return {
    source: {
      sourceSessionId: boundRequiredId(input.sourceSessionId, "SourceNerve session id"),
      runId: boundRequiredId(input.runId, "SourceNerve run id"),
      workspace: boundRequiredId(input.workspace, "SourceNerve workspace"),
    },
    frontend: input.frontend,
    boundAt: now,
    updatedAt: now,
  };
}

function boundRequiredId(value: string, label: string): string {
  if (!isSafeProviderId(value)) throw new Error(`${label} is invalid`);
  return value;
}

function isSafeProviderId(value: string): boolean {
  return value.length >= 1
    && Buffer.byteLength(value, "utf8") <= MAX_ID_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function boundIdLike(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value;
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return result;
}
