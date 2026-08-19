const MAX_URL_LENGTH = 8 * 1024;
const MAX_OAUTH_CODE_LENGTH = 4 * 1024;
const MAX_STATE_LENGTH = 1024;
const MAX_ERROR_LENGTH = 128;
const MAX_ERROR_DESCRIPTION_LENGTH = 1024;
const OAUTH_CALLBACK_PROTOCOL = "sourcenerve:";
const OAUTH_CALLBACK_HOST = "oauth";
const OAUTH_CALLBACK_PATH = "/callback";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const CALLBACK_QUERY_KEYS = new Set(["code", "state", "error", "error_description"]);

export type AuthCallback =
  | { kind: "success"; code: string; state: string }
  | { kind: "error"; error: string; errorDescription?: string; state: string };

export type PolicyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function validateDevServerUrl(value: string): PolicyResult<string> {
  const parsed = boundedUrl(value);
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password
  ) {
    return fail("Desktop development server must use loopback HTTP");
  }
  return { ok: true, value: url.toString() };
}

export function isAllowedRendererNavigation(
  targetValue: string,
  currentValue: string,
  devServerValue?: string,
): boolean {
  const target = boundedUrl(targetValue);
  const current = boundedUrl(currentValue);
  if (!target.ok || !current.ok) return false;

  if (devServerValue) {
    const devServer = validateDevServerUrl(devServerValue);
    if (!devServer.ok) return false;
    const dev = new URL(devServer.value);
    return (
      target.value.origin === dev.origin &&
      current.value.origin === dev.origin &&
      target.value.pathname === current.value.pathname &&
      target.value.search === current.value.search
    );
  }

  if (target.value.protocol !== "file:" || current.value.protocol !== "file:") return false;
  if (target.value.username || target.value.password || current.value.username || current.value.password) {
    return false;
  }
  return (
    target.value.hostname === current.value.hostname &&
    target.value.pathname === current.value.pathname &&
    target.value.search === current.value.search
  );
}

export function isTrustedRendererDocument(
  documentValue: string,
  currentValue: string,
  devServerValue?: string,
): boolean {
  return isAllowedRendererNavigation(documentValue, currentValue, devServerValue);
}

export function isAllowedExternalHttpsUrl(value: string, allowedOrigins: readonly string[]): boolean {
  const candidate = boundedUrl(value);
  if (!candidate.ok) return false;
  if (candidate.value.protocol !== "https:" || candidate.value.username || candidate.value.password) {
    return false;
  }
  return allowedOrigins.some((originValue) => {
    const origin = boundedUrl(originValue);
    return origin.ok && origin.value.protocol === "https:" && origin.value.origin === candidate.value.origin;
  });
}

export function parseAuthCallbackUrl(value: string): PolicyResult<AuthCallback> {
  const parsed = boundedUrl(value);
  if (!parsed.ok) return parsed;
  const url = parsed.value;
  if (
    url.protocol !== OAUTH_CALLBACK_PROTOCOL ||
    url.hostname !== OAUTH_CALLBACK_HOST ||
    url.pathname !== OAUTH_CALLBACK_PATH ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    return fail("invalid SourceNerve OAuth callback origin");
  }

  const seen = new Set<string>();
  for (const [key] of url.searchParams) {
    if (!CALLBACK_QUERY_KEYS.has(key)) return fail("OAuth callback contains an unsupported field");
    if (seen.has(key)) return fail("OAuth callback contains a duplicate field");
    seen.add(key);
  }

  const state = url.searchParams.get("state");
  if (!boundedToken(state, MAX_STATE_LENGTH)) return fail("OAuth callback state is missing or invalid");

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (Boolean(code) === Boolean(error)) {
    return fail("OAuth callback must contain exactly one of code or error");
  }

  if (code) {
    if (!boundedToken(code, MAX_OAUTH_CODE_LENGTH)) return fail("OAuth authorization code is invalid");
    if (url.searchParams.has("error_description")) {
      return fail("successful OAuth callback cannot contain error_description");
    }
    return { ok: true, value: { kind: "success", code, state } };
  }

  if (!error || error.length > MAX_ERROR_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(error)) {
    return fail("OAuth callback error is invalid");
  }
  const errorDescription = url.searchParams.get("error_description") ?? undefined;
  if (errorDescription && !boundedText(errorDescription, MAX_ERROR_DESCRIPTION_LENGTH)) {
    return fail("OAuth callback error description is invalid");
  }
  return {
    ok: true,
    value: {
      kind: "error",
      error,
      ...(errorDescription ? { errorDescription } : {}),
      state,
    },
  };
}

function boundedUrl(value: string): PolicyResult<URL> {
  if (!boundedText(value, MAX_URL_LENGTH)) return fail("URL is empty, oversized, or contains controls");
  try {
    return { ok: true, value: new URL(value) };
  } catch {
    return fail("URL is invalid");
  }
}

function boundedToken(value: string | null, maxLength: number): value is string {
  return Boolean(
    value &&
      value.length <= maxLength &&
      /^[A-Za-z0-9._~+/=-]+$/.test(value),
  );
}

function boundedText(value: string, maxLength: number): boolean {
  return value.length >= 1 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function fail<T = never>(error: string): PolicyResult<T> {
  return { ok: false, error };
}
