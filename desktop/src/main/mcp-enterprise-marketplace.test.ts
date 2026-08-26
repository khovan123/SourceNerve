import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseEnterpriseCatalogDocument,
  planGovernedMcpMarketplaceInstall,
} from "./mcp-enterprise-marketplace";

const catalogDocument = {
  schemaVersion: 1,
  servers: [
    {
      id: "jira",
      publisher: "acme",
      title: "Acme Jira MCP",
      description: "Organization-managed Jira connector",
      version: "1.4.2",
      transport: {
        transport: "streamable-http",
        url: "https://mcp.acme.test/jira",
      },
    },
  ],
};

function enterprisePolicy(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    catalogs: [
      {
        id: "acme",
        name: "Acme MCP Catalog",
        kind: "organization",
        url: "https://catalog.acme.test/mcp.json",
      },
    ],
    approvedPublishers: ["acme"],
    ...extra,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("enterprise MCP marketplace", () => {
  it("parses bounded private catalog entries and preserves explicit organization provenance", async () => {
    expect(parseEnterpriseCatalogDocument(catalogDocument).entries).toHaveLength(1);
    vi.stubEnv("SOURCENERVE_MCP_ENTERPRISE_POLICY", enterprisePolicy());
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(catalogDocument), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const plan = await planGovernedMcpMarketplaceInstall("org-acme/acme.jira");

    expect(plan.blockers).toEqual([]);
    expect(plan.server.registryName).toBe("org-acme/acme.jira");
    expect(plan.server.installHint).toContain("Organization catalog · Acme MCP Catalog");
    expect(plan.server.trust.reasons.join(" ")).toContain("centrally configured");
    expect(plan.input?.source).toBe("registry:org-acme/acme.jira");
    expect(plan.input?.transport).toEqual({
      transport: "streamable-http",
      url: "https://mcp.acme.test/jira",
    });
  });

  it("marks centrally blocked private-catalog versions as non-installable before activation", async () => {
    vi.stubEnv(
      "SOURCENERVE_MCP_ENTERPRISE_POLICY",
      enterprisePolicy({ versionPins: { "org-acme/acme.jira": "1.4.1" } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(catalogDocument), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const plan = await planGovernedMcpMarketplaceInstall("org-acme/acme.jira");

    expect(plan.server.canAutoInstall).toBe(false);
    expect(plan.blockers.join(" ")).toContain("pins org-acme/acme.jira to version 1.4.1");
  });

  it("rejects duplicate private catalog identities", () => {
    expect(() =>
      parseEnterpriseCatalogDocument({
        schemaVersion: 1,
        servers: [catalogDocument.servers[0], catalogDocument.servers[0]],
      }),
    ).toThrow(/duplicate server identity/i);
  });
});
