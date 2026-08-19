import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DeviceProviderProfile {
  clientId: string;
  flow: "device_authorization";
  deviceCodeUrl: string;
  tokenUrl: string;
  apiBaseUrl: string;
  verificationOrigin: string;
  scopes: string[];
}

export interface ProductProfile {
  schemaVersion: 1;
  product: {
    name: "SourceNerve";
    channel: "stable" | "preview" | "development";
    websiteUrl: string;
    supportUrl: string;
    privacyUrl: string;
    termsUrl: string;
  };
  daemon: {
    managed: true;
    bind: "127.0.0.1:7331";
    healthPath: "/healthz";
    readinessPath: string;
    mcpPath: "/mcp";
  };
  auth0: {
    issuer: string;
    nativeClientId: string;
    audience: string;
    scopes: string[];
    callbackUri: string;
    flow: "authorization_code_pkce";
  };
  gitProviders: {
    github: DeviceProviderProfile;
    gitlab: DeviceProviderProfile;
  };
  publicMcp: {
    resource: string;
    protectedResourceMetadata: string;
    routingMode: "bootstrap-broker" | "central-gateway";
    hostnameStrategy: "installation-scoped" | "gateway-routed";
  };
  bootstrapBroker: {
    baseUrl: string;
    enrollPath: string;
    rotateTunnelPath: string;
    revokePath: string;
    statusPath: string;
  };
  cloudflare: {
    mode: "broker-managed" | "gateway-managed";
    bundleCloudflared: boolean;
    desktopReceivesAccountApiToken: false;
    desktopReceivesInstallationCredential: boolean;
  };
  installation: {
    localBearerEntropyBits: number;
    generateInstallationId: true;
    secureStoreRequired: true;
  };
  workspace: {
    userSelectsRepository: true;
    userSelectsLocalRoot: true;
    userSelectsAccessMode: true;
    deriveProviderMetadata: true;
  };
}

export interface ManagedWorkspace {
  id: string;
  name: string;
  root: string;
  access: "read-only" | "read-write";
  remote: string;
  defaultBranch: string;
  provider?: "github" | "gitlab";
  repository?: string;
}

export interface OAuthGrant {
  subject: string;
  workspace: string;
  access: "read-only" | "read-write";
}

export interface MaterializeRuntimeInput {
  productProfile: ProductProfile;
  configPath: string;
  stateDirectory: string;
  localBearer: string;
  workspaces: ManagedWorkspace[];
  oauthGrants?: OAuthGrant[];
  githubToken?: string | null;
  gitlabToken?: string | null;
}

export interface MaterializedRuntime {
  configPath: string;
  environment: NodeJS.ProcessEnv;
}

const PLACEHOLDER_PATTERN = /^__[A-Z0-9_]+__$/;

export async function loadProductProfile(
  filePath: string,
  options: { allowPlaceholders: boolean },
): Promise<ProductProfile> {
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return validateProductProfile(parsed, options);
}

export function validateProductProfile(
  value: unknown,
  options: { allowPlaceholders: boolean },
): ProductProfile {
  if (!isRecord(value)) throw new Error("Desktop product profile must be an object");
  if (value.schemaVersion !== 1) throw new Error("unsupported Desktop product profile schemaVersion");

  const profile = value as unknown as ProductProfile;
  if (profile.product?.name !== "SourceNerve") throw new Error("unexpected Desktop product name");
  if (profile.daemon?.managed !== true || profile.daemon?.bind !== "127.0.0.1:7331") {
    throw new Error("Desktop SourceNerve daemon must stay managed and loopback-bound");
  }
  if (profile.daemon.healthPath !== "/healthz" || profile.daemon.mcpPath !== "/mcp") {
    throw new Error("Desktop daemon endpoint contract is invalid");
  }
  if (profile.auth0?.flow !== "authorization_code_pkce") {
    throw new Error("Desktop Auth0 flow must use authorization_code_pkce");
  }
  if (!isHttpsUrl(profile.auth0.issuer) || !profile.auth0.issuer.endsWith("/")) {
    throw new Error("Desktop Auth0 issuer must be a canonical HTTPS issuer");
  }
  if (profile.auth0.audience !== profile.publicMcp?.resource) {
    throw new Error("Desktop Auth0 audience must equal public MCP resource");
  }
  if (!profile.auth0.callbackUri?.startsWith("sourcenerve://")) {
    throw new Error("Desktop Auth0 callback URI must use the SourceNerve protocol");
  }
  validateDeviceProvider("GitHub", profile.gitProviders?.github);
  validateDeviceProvider("GitLab", profile.gitProviders?.gitlab);
  if (profile.installation?.localBearerEntropyBits < 256) {
    throw new Error("Desktop local bearer policy must provide at least 256 bits of entropy");
  }
  if (profile.installation?.secureStoreRequired !== true) {
    throw new Error("Desktop secure storage cannot be optional");
  }
  if (profile.cloudflare?.desktopReceivesAccountApiToken !== false) {
    throw new Error("Desktop must never receive the Cloudflare account API token");
  }
  if (!options.allowPlaceholders) {
    for (const [name, candidate] of [
      ["auth0.nativeClientId", profile.auth0.nativeClientId],
      ["bootstrapBroker.baseUrl", profile.bootstrapBroker?.baseUrl],
      ["gitProviders.github.clientId", profile.gitProviders.github.clientId],
      ["gitProviders.gitlab.clientId", profile.gitProviders.gitlab.clientId],
    ] as const) {
      if (!candidate || PLACEHOLDER_PATTERN.test(candidate)) {
        throw new Error(`unresolved packaged Desktop profile value: ${name}`);
      }
    }
  }
  return profile;
}

export async function materializeRuntime(
  input: MaterializeRuntimeInput,
): Promise<MaterializedRuntime> {
  validateMaterializationInput(input);
  const toml = buildRuntimeToml(input);
  await atomicWrite(input.configPath, toml);

  const environment: NodeJS.ProcessEnv = {
    SOURCENERVE_CONFIG: input.configPath,
    SOURCENERVE_BEARER_TOKEN: input.localBearer,
    SOURCENERVE_OAUTH_ISSUER: input.productProfile.auth0.issuer,
    SOURCENERVE_OAUTH_RESOURCE: input.productProfile.auth0.audience,
    SOURCENERVE_OAUTH_ALLOW_OPERATOR_BEARER: "false",
  };
  if (input.githubToken) environment.SOURCENERVE_GITHUB_TOKEN = input.githubToken;
  if (input.gitlabToken) environment.SOURCENERVE_GITLAB_TOKEN = input.gitlabToken;

  return { configPath: input.configPath, environment };
}

export function buildRuntimeToml(input: MaterializeRuntimeInput): string {
  validateMaterializationInput(input);
  const lines: string[] = [
    "# Generated by SourceNerve Desktop. User secrets are supplied out-of-band.",
    "[server]",
    `bind = ${tomlString(input.productProfile.daemon.bind)}`,
    "",
    "[storage]",
    `state_dir = ${tomlString(input.stateDirectory)}`,
    "",
    "[auth]",
    "# bearer_token is intentionally supplied through SOURCENERVE_BEARER_TOKEN.",
    "",
    "[oauth]",
    `issuer = ${tomlString(input.productProfile.auth0.issuer)}`,
    `resource = ${tomlString(input.productProfile.auth0.audience)}`,
    "allow_operator_bearer = false",
    "max_token_lifetime_seconds = 300",
  ];

  for (const grant of input.oauthGrants ?? []) {
    lines.push(
      "",
      "[[oauth.grant]]",
      `subject = ${tomlString(grant.subject)}`,
      `workspace = ${tomlString(grant.workspace)}`,
      `access = ${tomlString(grant.access)}`,
    );
  }

  lines.push("", "[github]", "# token is supplied through SOURCENERVE_GITHUB_TOKEN when configured.");

  for (const workspace of input.workspaces) {
    lines.push(
      "",
      "[[workspace]]",
      `id = ${tomlString(workspace.id)}`,
      `name = ${tomlString(workspace.name)}`,
      `root = ${tomlString(workspace.root)}`,
      `access = ${tomlString(workspace.access)}`,
      `remote = ${tomlString(workspace.remote)}`,
      `default_branch = ${tomlString(workspace.defaultBranch)}`,
    );
    if (workspace.provider) lines.push(`provider = ${tomlString(workspace.provider)}`);
    if (workspace.repository) lines.push(`repository = ${tomlString(workspace.repository)}`);
  }

  return `${lines.join("\n")}\n`;
}

function validateMaterializationInput(input: MaterializeRuntimeInput): void {
  validateProductProfile(input.productProfile, { allowPlaceholders: true });
  if (input.localBearer.length < 32 || input.localBearer.length > 256 || !isPrintableAscii(input.localBearer)) {
    throw new Error("Desktop local bearer must be 32-256 printable ASCII bytes");
  }
  for (const [name, token] of [["GitHub", input.githubToken], ["GitLab", input.gitlabToken]] as const) {
    if (token && (token.length < 20 || token.length > 4096 || !isPrintableAscii(token))) {
      throw new Error(`Desktop ${name} provider token has an invalid shape`);
    }
  }
  if (input.workspaces.length === 0) {
    throw new Error("Desktop runtime requires at least one selected workspace");
  }

  const ids = new Set<string>();
  for (const workspace of input.workspaces) {
    if (!validWorkspaceId(workspace.id)) throw new Error(`invalid workspace id: ${workspace.id}`);
    if (ids.has(workspace.id)) throw new Error(`duplicate workspace id: ${workspace.id}`);
    ids.add(workspace.id);
    if (!workspace.name.trim() || workspace.name.length > 128) throw new Error(`invalid workspace name: ${workspace.id}`);
    if (!path.isAbsolute(workspace.root)) throw new Error(`workspace root must be absolute: ${workspace.id}`);
    if (!workspace.remote.trim() || workspace.remote.length > 128) throw new Error(`invalid workspace remote: ${workspace.id}`);
    if (!workspace.defaultBranch.trim() || workspace.defaultBranch.length > 256) {
      throw new Error(`invalid workspace default branch: ${workspace.id}`);
    }
    if (workspace.repository && !workspace.provider) {
      throw new Error(`workspace repository requires provider: ${workspace.id}`);
    }
  }

  const grantKeys = new Set<string>();
  for (const grant of input.oauthGrants ?? []) {
    if (!grant.subject || grant.subject.length > 512 || /[\u0000-\u001f\u007f]/.test(grant.subject)) {
      throw new Error("invalid OAuth grant subject");
    }
    if (!ids.has(grant.workspace)) throw new Error(`OAuth grant references unknown workspace: ${grant.workspace}`);
    const key = `${grant.subject}\0${grant.workspace}`;
    if (grantKeys.has(key)) throw new Error(`duplicate OAuth grant for workspace: ${grant.workspace}`);
    grantKeys.add(key);
  }
}

function validateDeviceProvider(name: string, provider: DeviceProviderProfile | undefined): void {
  if (!provider || provider.flow !== "device_authorization") {
    throw new Error(`Desktop ${name} provider must use device_authorization`);
  }
  if (!provider.clientId || provider.clientId.length > 512) throw new Error(`Desktop ${name} client ID is invalid`);
  for (const [label, value] of [
    ["device endpoint", provider.deviceCodeUrl],
    ["token endpoint", provider.tokenUrl],
    ["API endpoint", provider.apiBaseUrl],
    ["verification origin", provider.verificationOrigin],
  ] as const) {
    if (!isCredentialFreeHttpsUrl(value)) throw new Error(`Desktop ${name} ${label} must use credential-free HTTPS`);
  }
  const verificationOrigin = new URL(provider.verificationOrigin).origin;
  if (new URL(provider.deviceCodeUrl).origin !== verificationOrigin || new URL(provider.tokenUrl).origin !== verificationOrigin) {
    throw new Error(`Desktop ${name} OAuth endpoints must stay on the configured verification origin`);
  }
  if (!Array.isArray(provider.scopes) || provider.scopes.length < 1 || new Set(provider.scopes).size !== provider.scopes.length) {
    throw new Error(`Desktop ${name} provider scopes are invalid`);
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

function tomlString(value: string): string {
  if (value.includes("\0")) throw new Error("TOML strings cannot contain NUL");
  return JSON.stringify(value);
}

function validWorkspaceId(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value);
}

function isPrintableAscii(value: string): boolean {
  return /^[\x21-\x7e]+$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}
