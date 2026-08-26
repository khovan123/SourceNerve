import { describe, expect, it } from "vitest";

import type { McpExtensionInstallInput } from "../shared/mcp-extension-api";
import {
  assertMcpEnterpriseExtensionAllowed,
  effectiveMcpEnterpriseToolPolicy,
  evaluateMcpEnterpriseExtension,
  governedExtensionFromInstall,
  parseMcpEnterpriseGovernance,
  versionMatches,
} from "./mcp-enterprise-governance";

function input(overrides: Partial<McpExtensionInstallInput> = {}): McpExtensionInstallInput {
  return {
    id: "jira-acme",
    name: "Jira",
    version: "1.4.2",
    namespace: "jira",
    source: "registry:acme/jira",
    transport: { transport: "streamable-http", url: "https://mcp.acme.test/mcp" },
    authType: "none",
    required: false,
    updateChannel: "stable",
    ...overrides,
  };
}

describe("enterprise MCP governance", () => {
  it("fails closed when a centrally denied extension would otherwise be allowed locally", () => {
    const policy = parseMcpEnterpriseGovernance({
      schemaVersion: 1,
      allow: {
        extensions: ["acme/*"],
        publishers: ["acme"],
        transports: ["streamable-http"],
      },
      deny: { extensions: ["jira-*"], publishers: [], transports: [] },
    });
    const decision = evaluateMcpEnterpriseExtension(governedExtensionFromInstall(input()), policy);
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(" ")).toContain("denies this MCP extension");
    expect(() =>
      assertMcpEnterpriseExtensionAllowed(
        governedExtensionFromInstall(input()),
        "install",
        policy,
      ),
    ).toThrow(/Enterprise MCP governance blocked install/);
  });

  it("enforces version pins, allowed ranges and blocked upgrade ranges", () => {
    const policy = parseMcpEnterpriseGovernance({
      schemaVersion: 1,
      versionPins: { "acme/jira": "1.4.2" },
      allowedVersions: { "acme/jira": [">=1.4.0 <2.0.0"] },
      blockedVersions: { "acme/jira": [">=1.5.0 <1.6.0"] },
    });

    expect(
      evaluateMcpEnterpriseExtension(governedExtensionFromInstall(input()), policy).allowed,
    ).toBe(true);

    const upgrade = governedExtensionFromInstall(input({ version: "1.5.1" }));
    const decision = evaluateMcpEnterpriseExtension(upgrade, policy);
    expect(decision.allowed).toBe(false);
    expect(decision.blockers.join(" ")).toContain("pins acme/jira to version 1.4.2");
    expect(decision.blockers.join(" ")).toContain("blocked by organization policy");
  });

  it("keeps user policy when it is stricter but prevents weakening central templates", () => {
    const policy = parseMcpEnterpriseGovernance({
      schemaVersion: 1,
      toolPolicies: [
        { extension: "jira-*", tool: "create_*", enabled: true, approval: "ask" },
      ],
      revokedTools: [{ extension: "jira-*", tool: "delete_*" }],
    });

    expect(
      effectiveMcpEnterpriseToolPolicy(
        "jira-acme",
        "create_issue",
        { enabled: true, approval: "automatic" },
        policy,
      ),
    ).toEqual({ enabled: true, approval: "ask" });

    expect(
      effectiveMcpEnterpriseToolPolicy(
        "jira-acme",
        "create_issue",
        { enabled: false, approval: "blocked" },
        policy,
      ),
    ).toEqual({ enabled: false, approval: "blocked" });

    expect(
      effectiveMcpEnterpriseToolPolicy(
        "jira-acme",
        "delete_issue",
        { enabled: true, approval: "automatic" },
        policy,
      ),
    ).toEqual({ enabled: false, approval: "blocked" });
  });

  it("treats emergency extension revocation as stronger than approval", () => {
    const policy = parseMcpEnterpriseGovernance({
      schemaVersion: 1,
      approvedExtensions: ["jira-*"],
      revokedExtensions: ["jira-*"],
    });
    const decision = evaluateMcpEnterpriseExtension(governedExtensionFromInstall(input()), policy);
    expect(decision.approved).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.blockers[0]).toContain("emergency-revoked");
  });

  it("supports bounded comparator and wildcard version rules", () => {
    expect(versionMatches("1.5.3", ">=1.5.0 <2.0.0")).toBe(true);
    expect(versionMatches("1.5.3", "1.5.x")).toBe(true);
    expect(versionMatches("2.0.0", "1.5.x")).toBe(false);
    expect(versionMatches("1.4.9", ">=1.5.0")).toBe(false);
  });
});
