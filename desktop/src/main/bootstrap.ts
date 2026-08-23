import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { ElectronSafeStorageBackend } from "./electron-safe-storage";
import { ensureInstallationIdentity, type InstallationIdentity } from "./installation";
import {
  EncryptedSecretStore,
  type SecretPresence,
} from "./secure-store";
import {
  loadProductProfile,
  SERVER_MANAGED_PROFILE_VALUE,
  validateProductProfile,
  type ProductProfile,
} from "./runtime-profile";
import { resolveStateDirectoryFromManagedDirectory } from "./state-location";

const CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS = 4_000;
const CLIENT_CONFIG_MAX_ATTEMPTS = 3;
const CLIENT_CONFIG_RETRY_DELAYS_MS = [250, 750] as const;
const RETRYABLE_CLIENT_CONFIG_STATUS = new Set([502, 503, 504]);
const MAX_CLIENT_CONFIG_BYTES = 64 * 1024;
const CLIENT_CONFIG_CACHE_SCHEMA_VERSION = 1 as const;
const MAX_CLIENT_CONFIG_CACHE_BYTES = 80 * 1024;
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

export interface DesktopBootstrapPaths {
  userData: string;
  managedDirectory: string;
  secureDirectory: string;
  stateDirectory: string;
  configPath: string;
  workspaceRegistryPath: string;
  productProfilePath: string;
  clientConfigCachePath: string;
}

export interface DesktopBootstrapState {
  profile: ProductProfile;
  installation: InstallationIdentity;
  secretStore: EncryptedSecretStore;
  paths: DesktopBootstrapPaths;
  storageBackend: string;
  secretPresence: SecretPresence[];
}

interface DesktopClientConfigResponse {
  auth0: {
    issuer: string;
    audience: string;
    nativeClientId: string;
  };
  publicMcp: {
    resource: string;
    protectedResourceMetadata: string;
  };
}

interface DesktopClientConfigCache {
  schemaVersion: typeof CLIENT_CONFIG_CACHE_SCHEMA_VERSION;
  config: DesktopClientConfigResponse;
}

export async function prepareDesktopBootstrap(options: {
  appPath: string;
  userData: string;
  packaged: boolean;
}): Promise<DesktopBootstrapState> {
  const managedDirectory = path.join(options.userData, "managed");
  const secureDirectory = path.join(options.userData, "secure");
  const defaultStateDirectory = path.join(options.userData, "state");
  const productProfileRoot = options.packaged ? process.resourcesPath : options.appPath;
  const paths: DesktopBootstrapPaths = {
    userData: options.userData,
    managedDirectory,
    secureDirectory,
    stateDirectory: await resolveStateDirectoryFromManagedDirectory(
      managedDirectory,
      defaultStateDirectory,
    ),
    configPath: path.join(managedDirectory, "sourcenerve.toml"),
    workspaceRegistryPath: path.join(managedDirectory, "workspaces.json"),
    productProfilePath: path.join(
      productProfileRoot,
      "bootstrap",
      "product-profile.template.json",
    ),
    clientConfigCachePath: path.join(managedDirectory, "desktop-client-config.json"),
  };

  const template = await loadProductProfile(paths.productProfilePath, {
    allowPlaceholders: true,
  });
  const profile = await resolveServerManagedClientConfig(
    template,
    paths.clientConfigCachePath,
  );
  const secretStore = new EncryptedSecretStore(
    secureDirectory,
    new ElectronSafeStorageBackend(),
  );
  const storageBackend = secretStore.storageBackend();
  const installation = await ensureInstallationIdentity(
    managedDirectory,
    secretStore,
  );
  const secretPresence = await secretStore.presence();

  return {
    profile,
    installation,
    secretStore,
    paths,
    storageBackend,
    secretPresence,
  };
}

async function resolveServerManagedClientConfig(
  template: ProductProfile,
  cachePath: string,
): Promise<ProductProfile> {
  if (
    template.auth0.issuer !== SERVER_MANAGED_PROFILE_VALUE ||
    template.auth0.nativeClientId !== SERVER_MANAGED_PROFILE_VALUE ||
    template.auth0.audience !== SERVER_MANAGED_PROFILE_VALUE ||
    template.publicMcp.resource !== SERVER_MANAGED_PROFILE_VALUE ||
    template.publicMcp.protectedResourceMetadata !== SERVER_MANAGED_PROFILE_VALUE
  ) {
    throw new Error("Desktop Auth0 and public MCP configuration must be server-managed");
  }

  const baseUrl = template.bootstrapBroker.baseUrl;
  if (!baseUrl || PLACEHOLDER_PATTERN.test(baseUrl)) {
    throw new Error("Desktop bootstrap broker URL is unresolved; configure desktop/.env before packaging or development startup");
  }

  let endpoint: URL;
  try {
    const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
    endpoint = new URL(template.bootstrapBroker.clientConfigPath.replace(/^\//, ""), normalizedBase);
  } catch {
    throw new Error("Desktop bootstrap broker URL is invalid");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("Desktop bootstrap client config endpoint must use credential-free HTTPS");
  }

  const value = await resolveDesktopClientConfig(endpoint, cachePath);
  const resolved = structuredClone(template);
  resolved.auth0.issuer = value.auth0.issuer;
  resolved.auth0.nativeClientId = value.auth0.nativeClientId;
  resolved.auth0.audience = value.auth0.audience;
  resolved.publicMcp.resource = value.publicMcp.resource;
  resolved.publicMcp.protectedResourceMetadata = value.publicMcp.protectedResourceMetadata;
  return validateProductProfile(resolved, { allowPlaceholders: false });
}

export async function resolveDesktopClientConfig(
  endpoint: URL,
  cachePath: string,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<DesktopClientConfigResponse> {
  try {
    const response = await fetchDesktopClientConfigResponse(endpoint, options);
    const value = await parseDesktopClientConfigResponse(response);
    await writeDesktopClientConfigCache(cachePath, value).catch(() => undefined);
    return value;
  } catch (error) {
    if (!isTransientClientConfigError(error)) throw error;
    const cached = await readDesktopClientConfigCache(cachePath);
    if (cached) return cached;
    throw error;
  }
}

export async function fetchDesktopClientConfigResponse(
  endpoint: URL,
  options: {
    fetchImpl?: typeof fetch;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastRetryableStatus: number | undefined;

  for (let attempt = 0; attempt < CLIENT_CONFIG_MAX_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(CLIENT_CONFIG_ATTEMPT_TIMEOUT_MS),
      });
    } catch {
      if (attempt === CLIENT_CONFIG_MAX_ATTEMPTS - 1) {
        throw new Error("SourceNerve backend client configuration is unavailable");
      }
      await sleep(CLIENT_CONFIG_RETRY_DELAYS_MS[attempt] ?? 750);
      continue;
    }

    if (response.ok) return response;
    if (!RETRYABLE_CLIENT_CONFIG_STATUS.has(response.status)) {
      throw new Error(`SourceNerve backend client configuration returned HTTP ${response.status}`);
    }

    lastRetryableStatus = response.status;
    if (attempt < CLIENT_CONFIG_MAX_ATTEMPTS - 1) {
      await sleep(CLIENT_CONFIG_RETRY_DELAYS_MS[attempt] ?? 750);
    }
  }

  throw new Error(
    `SourceNerve backend client configuration returned HTTP ${lastRetryableStatus ?? 503}`,
  );
}

async function parseDesktopClientConfigResponse(
  response: Response,
): Promise<DesktopClientConfigResponse> {
  const raw = await response.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_CLIENT_CONFIG_BYTES) {
    throw new Error("SourceNerve backend client configuration response is oversized");
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("SourceNerve backend client configuration returned invalid JSON");
  }
  if (!isClientConfig(value)) {
    throw new Error("SourceNerve backend client configuration has an invalid shape");
  }
  return value;
}

async function readDesktopClientConfigCache(
  cachePath: string,
): Promise<DesktopClientConfigResponse | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    if (Buffer.byteLength(raw, "utf8") > MAX_CLIENT_CONFIG_CACHE_BYTES) return null;
    const value = JSON.parse(raw) as Partial<DesktopClientConfigCache>;
    if (
      value.schemaVersion !== CLIENT_CONFIG_CACHE_SCHEMA_VERSION ||
      !isClientConfig(value.config)
    ) {
      return null;
    }
    return structuredClone(value.config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
}

async function writeDesktopClientConfigCache(
  cachePath: string,
  config: DesktopClientConfigResponse,
): Promise<void> {
  await mkdir(path.dirname(cachePath), { recursive: true, mode: 0o700 });
  const temporary = `${cachePath}.tmp-${process.pid}`;
  const payload: DesktopClientConfigCache = {
    schemaVersion: CLIENT_CONFIG_CACHE_SCHEMA_VERSION,
    config,
  };
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, cachePath);
}

function isTransientClientConfigError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "SourceNerve backend client configuration is unavailable" ||
    /^SourceNerve backend client configuration returned HTTP (502|503|504)$/.test(error.message)
  );
}

function isClientConfig(value: unknown): value is DesktopClientConfigResponse {
  if (!value || typeof value !== "object") return false;
  const root = value as Partial<DesktopClientConfigResponse>;
  const auth0 = root.auth0;
  const publicMcp = root.publicMcp;
  return Boolean(
    auth0 &&
      typeof auth0.issuer === "string" &&
      typeof auth0.audience === "string" &&
      typeof auth0.nativeClientId === "string" &&
      publicMcp &&
      typeof publicMcp.resource === "string" &&
      typeof publicMcp.protectedResourceMetadata === "string" &&
      auth0.audience === publicMcp.resource,
  );
}
