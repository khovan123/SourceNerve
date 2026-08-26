import { readFileSync } from "node:fs";
import path from "node:path";

import type {
  McpExtensionInstallInput,
  McpExtensionToolPolicyInput,
  McpExtensionView,
  McpToolApproval,
} from "../shared/mcp-extension-api";

const POLICY_ENV = "SOURCENERVE_MCP_ENTERPRISE_POLICY";
const POLICY_FILE_ENV = "SOURCENERVE_MCP_ENTERPRISE_POLICY_FILE";
const MAX_POLICY_BYTES = 256 * 1024;
const MAX_RULES = 256;
const MAX_CATALOGS = 8;
const MAX_PATTERN_LENGTH = 160;

export type McpEnterpriseCatalogKind = "organization" | "private";

export interface McpEnterpriseCatalog {
  id: string;
  name: string;
  kind: McpEnterpriseCatalogKind;
  url: string;
}

export interface McpEnterpriseRuleSet {
  extensions: string[];
  publishers: string[];
  transports: Array<"stdio" | "streamable-http">;
}

export interface McpEnterpriseToolTemplate {
  extension: string;
  tool: string;
  enabled?: boolean;
  approval?: McpToolApproval;
}

export interface McpEnterpriseToolRevoke {
  extension: string;
  tool: string;
}

export interface McpEnterpriseGovernancePolicy {
  managed: boolean;
  catalogs: McpEnterpriseCatalog[];
  allow: McpEnterpriseRuleSet;
  deny: McpEnterpriseRuleSet;
  approvedExtensions: string[];
  approvedPublishers: string[];
  versionPins: Record<string, string>;
  allowedVersions: Record<string, string[]>;
  blockedVersions: Record<string, string[]>;
  toolPolicies: McpEnterpriseToolTemplate[];
  revokedExtensions: string[];
  revokedTools: McpEnterpriseToolRevoke[];
}

export interface McpGovernanceDecision {
  managed: boolean;
  allowed: boolean;
  approved: boolean;
  blockers: string[];
}

export interface McpGovernedExtension {
  id: string;
  version: string;
  source: string;
  transport: "stdio" | "streamable-http";
}

const EMPTY_POLICY: McpEnterpriseGovernancePolicy = Object.freeze({
  managed: false,
  catalogs: [],
  allow: { extensions: [], publishers: [], transports: [] },
  deny: { extensions: [], publishers: [], transports: [] },
  approvedExtensions: [],
  approvedPublishers: [],
  versionPins: {},
  allowedVersions: {},
  blockedVersions: {},
  toolPolicies: [],
  revokedExtensions: [],
  revokedTools: [],
});

export function loadMcpEnterpriseGovernance(
  environment: NodeJS.ProcessEnv = process.env,
): McpEnterpriseGovernancePolicy {
  const inline = environment[POLICY_ENV]?.trim();
  const file = environment[POLICY_FILE_ENV]?.trim();
  if (inline && file) {
    throw new Error(
      `${POLICY_ENV} and ${POLICY_FILE_ENV} cannot both be configured; enterprise MCP governance fails closed on ambiguous policy sources`,
    );
  }
  if (!inline && !file) return EMPTY_POLICY;

  let raw: string;
  if (inline) {
    raw = inline;
  } else {
    if (!file || !path.isAbsolute(file)) {
      throw new Error(`${POLICY_FILE_ENV} must be an absolute path`);
    }
    raw = readFileSync(file, "utf8");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_POLICY_BYTES) {
    throw new Error("Enterprise MCP governance policy exceeds the SourceNerve size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Enterprise MCP governance policy is not valid JSON");
  }
  return parseMcpEnterpriseGovernance(parsed);
}

export function parseMcpEnterpriseGovernance(value: unknown): McpEnterpriseGovernancePolicy {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Enterprise MCP governance policy must use schemaVersion 1");
  }
  const allowedTopLevel = new Set([
    "schemaVersion",
    "catalogs",
    "allow",
    "deny",
    "approvedExtensions",
    "approvedPublishers",
    "versionPins",
    "allowedVersions",
    "blockedVersions",
    "toolPolicies",
    "revokedExtensions",
    "revokedTools",
  ]);
  if (Object.keys(value).some((key) => !allowedTopLevel.has(key))) {
    throw new Error("Enterprise MCP governance policy contains unsupported fields");
  }

  return {
    managed: true,
    catalogs: parseCatalogs(value.catalogs),
    allow: parseRuleSet(value.allow),
    deny: parseRuleSet(value.deny),
    approvedExtensions: parsePatterns(value.approvedExtensions, "approvedExtensions"),
    approvedPublishers: parsePatterns(value.approvedPublishers, "approvedPublishers"),
    versionPins: parseVersionMap(value.versionPins, false, "versionPins"),
    allowedVersions: parseVersionMap(value.allowedVersions, true, "allowedVersions"),
    blockedVersions: parseVersionMap(value.blockedVersions, true, "blockedVersions"),
    toolPolicies: parseToolPolicies(value.toolPolicies),
    revokedExtensions: parsePatterns(value.revokedExtensions, "revokedExtensions"),
    revokedTools: parseRevokedTools(value.revokedTools),
  };
}

export function governedExtensionFromInstall(input: McpExtensionInstallInput): McpGovernedExtension {
  return {
    id: input.id,
    version: input.version,
    source: input.source,
    transport: input.transport.transport,
  };
}

export function governedExtensionFromView(view: McpExtensionView): McpGovernedExtension {
  return {
    id: view.id,
    version: view.version,
    source: view.source,
    transport: view.transport.transport,
  };
}

export function evaluateMcpEnterpriseExtension(
  extension: McpGovernedExtension,
  policy: McpEnterpriseGovernancePolicy = loadMcpEnterpriseGovernance(),
): McpGovernanceDecision {
  if (!policy.managed) {
    return { managed: false, allowed: true, approved: false, blockers: [] };
  }

  const identities = extensionIdentities(extension);
  const publisher = extensionPublisher(extension.source);
  const approvedExtension = matchesAny(identities, policy.approvedExtensions);
  const approvedPublisher = publisher !== undefined && matchesAny([publisher], policy.approvedPublishers);
  const approved = approvedExtension || approvedPublisher;
  const blockers: string[] = [];

  if (matchesAny(identities, policy.revokedExtensions)) {
    blockers.push("Organization policy emergency-revoked this MCP extension.");
  }
  if (matchesAny(identities, policy.deny.extensions)) {
    blockers.push("Organization policy denies this MCP extension.");
  }
  if (
    policy.allow.extensions.length > 0 &&
    !approvedExtension &&
    !matchesAny(identities, policy.allow.extensions)
  ) {
    blockers.push("This MCP extension is outside the organization allowlist.");
  }

  if (publisher && matchesAny([publisher], policy.deny.publishers)) {
    blockers.push(`Organization policy denies publisher ${publisher}.`);
  }
  if (
    policy.allow.publishers.length > 0 &&
    !approvedExtension &&
    !approvedPublisher &&
    (!publisher || !matchesAny([publisher], policy.allow.publishers))
  ) {
    blockers.push(
      publisher
        ? `Publisher ${publisher} is outside the organization allowlist.`
        : "This MCP extension has no publisher identity accepted by organization policy.",
    );
  }

  if (policy.deny.transports.includes(extension.transport)) {
    blockers.push(`Organization policy denies ${extension.transport} MCP transport.`);
  }
  if (
    policy.allow.transports.length > 0 &&
    !policy.allow.transports.includes(extension.transport)
  ) {
    blockers.push(`${extension.transport} MCP transport is outside the organization allowlist.`);
  }

  const pin = firstVersionRule(identities, policy.versionPins);
  if (pin && extension.version !== pin.value) {
    blockers.push(
      `Organization policy pins ${pin.pattern} to version ${pin.value}; requested version is ${extension.version}.`,
    );
  }

  const allowedVersions = firstVersionRule(identities, policy.allowedVersions);
  if (
    allowedVersions &&
    !allowedVersions.value.some((constraint) => versionMatches(extension.version, constraint))
  ) {
    blockers.push(
      `Version ${extension.version} is outside the organization-approved version range for ${allowedVersions.pattern}.`,
    );
  }

  const blockedVersions = allVersionRules(identities, policy.blockedVersions);
  for (const rule of blockedVersions) {
    const blocked = rule.value.find((constraint) => versionMatches(extension.version, constraint));
    if (blocked) {
      blockers.push(
        `Version ${extension.version} is blocked by organization policy for ${rule.pattern} (${blocked}).`,
      );
      break;
    }
  }

  return { managed: true, allowed: blockers.length === 0, approved, blockers };
}

export function assertMcpEnterpriseExtensionAllowed(
  extension: McpGovernedExtension,
  operation: "install" | "update" | "enable" | "restart" | "rollback" = "install",
  policy: McpEnterpriseGovernancePolicy = loadMcpEnterpriseGovernance(),
): McpGovernanceDecision {
  const decision = evaluateMcpEnterpriseExtension(extension, policy);
  if (!decision.allowed) {
    throw new Error(
      `Enterprise MCP governance blocked ${operation}: ${decision.blockers.join(" ")}`,
    );
  }
  return decision;
}

export function effectiveMcpEnterpriseToolPolicy(
  extensionId: string,
  toolName: string,
  requested: Pick<McpExtensionToolPolicyInput, "enabled" | "approval">,
  policy: McpEnterpriseGovernancePolicy = loadMcpEnterpriseGovernance(),
): Pick<McpExtensionToolPolicyInput, "enabled" | "approval"> {
  if (!policy.managed) return { ...requested };
  if (
    policy.revokedTools.some(
      (rule) => wildcardMatch(extensionId, rule.extension) && wildcardMatch(toolName, rule.tool),
    )
  ) {
    return { enabled: false, approval: "blocked" };
  }

  let central: McpEnterpriseToolTemplate | undefined;
  for (const template of policy.toolPolicies) {
    if (wildcardMatch(extensionId, template.extension) && wildcardMatch(toolName, template.tool)) {
      central = template;
    }
  }
  if (!central) return { ...requested };

  const enabled = requested.enabled && central.enabled !== false;
  const approval = stricterApproval(requested.approval, central.approval);
  return { enabled, approval };
}

export function enterpriseCatalogs(
  policy: McpEnterpriseGovernancePolicy = loadMcpEnterpriseGovernance(),
): McpEnterpriseCatalog[] {
  return policy.catalogs.map((catalog) => ({ ...catalog }));
}

export function versionMatches(version: string, constraint: string): boolean {
  const trimmed = constraint.trim();
  if (!trimmed || trimmed === "*") return true;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  return tokens.every((token) => versionTokenMatches(version, token));
}

function parseCatalogs(value: unknown): McpEnterpriseCatalog[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CATALOGS) {
    throw new Error(`Enterprise MCP governance may define at most ${MAX_CATALOGS} catalogs`);
  }
  const ids = new Set<string>();
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Enterprise MCP catalog entry is invalid");
    const allowed = new Set(["id", "name", "kind", "url"]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
      throw new Error("Enterprise MCP catalog entry contains unsupported fields");
    }
    const id = text(candidate.id, 48);
    const name = text(candidate.name, 120);
    if (!id || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(id) || ids.has(id)) {
      throw new Error("Enterprise MCP catalog id is invalid or duplicated");
    }
    ids.add(id);
    if (!name) throw new Error(`Enterprise MCP catalog ${id} name is invalid`);
    if (candidate.kind !== "organization" && candidate.kind !== "private") {
      throw new Error(`Enterprise MCP catalog ${id} kind is invalid`);
    }
    const url = httpsUrl(candidate.url);
    if (!url) throw new Error(`Enterprise MCP catalog ${id} URL must be fixed HTTPS`);
    return { id, name, kind: candidate.kind, url };
  });
}

function parseRuleSet(value: unknown): McpEnterpriseRuleSet {
  if (value === undefined) return { extensions: [], publishers: [], transports: [] };
  if (!isRecord(value)) throw new Error("Enterprise MCP allow/deny rule set is invalid");
  const allowed = new Set(["extensions", "publishers", "transports"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Enterprise MCP allow/deny rule set contains unsupported fields");
  }
  const transports = value.transports === undefined ? [] : value.transports;
  if (
    !Array.isArray(transports) ||
    transports.length > 2 ||
    transports.some((transport) => transport !== "stdio" && transport !== "streamable-http")
  ) {
    throw new Error("Enterprise MCP transport allow/deny rule is invalid");
  }
  return {
    extensions: parsePatterns(value.extensions, "extensions"),
    publishers: parsePatterns(value.publishers, "publishers"),
    transports: [...new Set(transports)] as Array<"stdio" | "streamable-http">,
  };
}

function parsePatterns(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    throw new Error(`Enterprise MCP ${label} rule list is invalid`);
  }
  const patterns: string[] = [];
  for (const candidate of value) {
    const pattern = text(candidate, MAX_PATTERN_LENGTH);
    if (!pattern || !/^[A-Za-z0-9._:/?*+-]+$/.test(pattern)) {
      throw new Error(`Enterprise MCP ${label} contains an invalid pattern`);
    }
    if (!patterns.includes(pattern)) patterns.push(pattern);
  }
  return patterns;
}

function parseVersionMap(
  value: unknown,
  arrays: false,
  label: string,
): Record<string, string>;
function parseVersionMap(
  value: unknown,
  arrays: true,
  label: string,
): Record<string, string[]>;
function parseVersionMap(
  value: unknown,
  arrays: boolean,
  label: string,
): Record<string, string | string[]> {
  if (value === undefined) return {};
  if (!isRecord(value) || Object.keys(value).length > MAX_RULES) {
    throw new Error(`Enterprise MCP ${label} map is invalid`);
  }
  const result: Record<string, string | string[]> = {};
  for (const [pattern, raw] of Object.entries(value)) {
    if (!parsePatterns([pattern], label)[0]) throw new Error(`Enterprise MCP ${label} key is invalid`);
    if (arrays) {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 32) {
        throw new Error(`Enterprise MCP ${label}.${pattern} must be a non-empty constraint list`);
      }
      const constraints = raw.map((candidate) => versionConstraint(candidate, label));
      result[pattern] = constraints;
    } else {
      result[pattern] = versionConstraint(raw, label);
    }
  }
  return result;
}

function parseToolPolicies(value: unknown): McpEnterpriseToolTemplate[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    throw new Error("Enterprise MCP toolPolicies list is invalid");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Enterprise MCP tool policy is invalid");
    const allowed = new Set(["extension", "tool", "enabled", "approval"]);
    if (Object.keys(candidate).some((key) => !allowed.has(key))) {
      throw new Error("Enterprise MCP tool policy contains unsupported fields");
    }
    const extension = parsePatterns([candidate.extension], "toolPolicies.extension")[0];
    const tool = parsePatterns([candidate.tool], "toolPolicies.tool")[0];
    if (!extension || !tool) throw new Error("Enterprise MCP tool policy target is invalid");
    if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
      throw new Error("Enterprise MCP tool policy enabled value is invalid");
    }
    if (candidate.approval !== undefined && !isApproval(candidate.approval)) {
      throw new Error("Enterprise MCP tool policy approval value is invalid");
    }
    return {
      extension,
      tool,
      ...(candidate.enabled !== undefined ? { enabled: candidate.enabled } : {}),
      ...(candidate.approval !== undefined ? { approval: candidate.approval } : {}),
    };
  });
}

function parseRevokedTools(value: unknown): McpEnterpriseToolRevoke[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    throw new Error("Enterprise MCP revokedTools list is invalid");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate) || Object.keys(candidate).some((key) => !["extension", "tool"].includes(key))) {
      throw new Error("Enterprise MCP revoked tool rule is invalid");
    }
    const extension = parsePatterns([candidate.extension], "revokedTools.extension")[0];
    const tool = parsePatterns([candidate.tool], "revokedTools.tool")[0];
    if (!extension || !tool) throw new Error("Enterprise MCP revoked tool target is invalid");
    return { extension, tool };
  });
}

function versionConstraint(value: unknown, label: string): string {
  const constraint = text(value, 120);
  if (!constraint || !/^[0-9A-Za-z.*xXvV<>=+\-\s]+$/.test(constraint)) {
    throw new Error(`Enterprise MCP ${label} contains an invalid version constraint`);
  }
  return constraint;
}

function extensionIdentities(extension: McpGovernedExtension): string[] {
  const result = [extension.id];
  if (extension.source.startsWith("registry:")) result.push(extension.source.slice("registry:".length));
  else if (extension.source.startsWith("plugin-hub:")) {
    const plugin = extension.source.split(":")[1];
    if (plugin) result.push(`plugin:${plugin}`);
  }
  result.push(extension.source);
  return result;
}

function extensionPublisher(source: string): string | undefined {
  if (!source.startsWith("registry:")) return undefined;
  const reference = source.slice("registry:".length);
  const [namespace, leaf] = reference.split("/", 2);
  if (!namespace || !leaf) return undefined;
  if (namespace.startsWith("org-") || namespace.startsWith("private-")) {
    const publisher = leaf.split(".", 1)[0];
    return publisher || undefined;
  }
  return namespace;
}

function matchesAny(values: string[], patterns: string[]): boolean {
  return patterns.some((pattern) => values.some((value) => wildcardMatch(value, pattern)));
}

function wildcardMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
  return regex.test(value);
}

function firstVersionRule<T>(
  identities: string[],
  rules: Record<string, T>,
): { pattern: string; value: T } | undefined {
  for (const [pattern, value] of Object.entries(rules)) {
    if (matchesAny(identities, [pattern])) return { pattern, value };
  }
  return undefined;
}

function allVersionRules<T>(
  identities: string[],
  rules: Record<string, T>,
): Array<{ pattern: string; value: T }> {
  return Object.entries(rules)
    .filter(([pattern]) => matchesAny(identities, [pattern]))
    .map(([pattern, value]) => ({ pattern, value }));
}

function versionTokenMatches(version: string, token: string): boolean {
  if (token === "*") return true;
  const wildcard = token.match(/^v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/);
  if (wildcard && /[xX*]/.test(token)) {
    const actual = parseSemver(version);
    if (!actual) return false;
    const major = Number(wildcard[1]);
    if (actual[0] !== major) return false;
    if (wildcard[2] && !/[xX*]/.test(wildcard[2]) && actual[1] !== Number(wildcard[2])) return false;
    if (wildcard[3] && !/[xX*]/.test(wildcard[3]) && actual[2] !== Number(wildcard[3])) return false;
    return true;
  }

  const comparator = token.match(/^(<=|>=|<|>|=)?(v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?)$/);
  if (!comparator) return version === token;
  const operator = comparator[1] ?? "=";
  const expected = parseSemver(comparator[2]);
  const actual = parseSemver(version);
  if (!expected || !actual) return operator === "=" && version === comparator[2];
  const comparison = compareSemver(actual, expected);
  if (operator === "=") return comparison === 0;
  if (operator === ">") return comparison > 0;
  if (operator === ">=") return comparison >= 0;
  if (operator === "<") return comparison < 0;
  return comparison <= 0;
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)];
}

function compareSemver(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function stricterApproval(
  requested: McpToolApproval,
  central: McpToolApproval | undefined,
): McpToolApproval {
  if (!central) return requested;
  const rank: Record<McpToolApproval, number> = { automatic: 0, ask: 1, blocked: 2 };
  return rank[central] > rank[requested] ? central : requested;
}

function isApproval(value: unknown): value is McpToolApproval {
  return value === "automatic" || value === "ask" || value === "blocked";
}

function httpsUrl(value: unknown): string | undefined {
  const candidate = text(value, 2048);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value.trim() !== value) {
    return undefined;
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
