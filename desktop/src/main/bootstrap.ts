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

const CLIENT_CONFIG_TIMEOUT_MS = 12_000;
const MAX_CLIENT_CONFIG_BYTES = 64 * 1024;
const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

export interface DesktopBootstrapPaths {
  userData: string;
  managedDirectory: string;
  secureDirectory: string;
  stateDirectory: string;
  configPath: string;
  workspaceRegistryPath: string;
  productProfilePath: string;
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
  };

  const template = await loadProductProfile(paths.productProfilePath, {
    allowPlaceholders: true,
  });
  const profile = await resolveServerManagedClientConfig(template);
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

async function resolveServerManagedClientConfig(template: ProductProfile): Promise<ProductProfile> {
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

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(CLIENT_CONFIG_TIMEOUT_MS),
    });
  } catch {
    throw new Error("SourceNerve backend client configuration is unavailable");
  }
  if (!response.ok) {
    throw new Error(`SourceNerve backend client configuration returned HTTP ${response.status}`);
  }
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

  const resolved = structuredClone(template);
  resolved.auth0.issuer = value.auth0.issuer;
  resolved.auth0.nativeClientId = value.auth0.nativeClientId;
  resolved.auth0.audience = value.auth0.audience;
  resolved.publicMcp.resource = value.publicMcp.resource;
  resolved.publicMcp.protectedResourceMetadata = value.publicMcp.protectedResourceMetadata;
  return validateProductProfile(resolved, { allowPlaceholders: false });
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
