import { describe, expect, it } from "vitest";

import { chooseMcpAuthorizationScopes } from "./mcp-auth-discovery";

const ATLASSIAN_ROVO_SCOPES = [
  "read:me",
  "read:account",
  "offline_access",
  "email",
  "read:jira-work",
  "write:jira-work",
  "search:confluence",
  "read:confluence-user",
  "read:page:confluence",
  "write:page:confluence",
  "read:comment:confluence",
  "write:comment:confluence",
  "read:space:confluence",
  "read:hierarchical-content:confluence",
  "write:component:compass",
  "read:component:compass",
  "read:scorecard:compass",
  "write:scorecard:compass",
  "read:event:compass",
  "read:metric:compass",
  "read:all:twg",
  "write:all:twg",
];

describe("MCP OAuth scope selection", () => {
  it("uses the complete bounded protected-resource scope set for Atlassian Rovo authv2", () => {
    const scopes = chooseMcpAuthorizationScopes(
      "https://mcp.atlassian.com/v1/mcp/authv2",
      [
        "read:jira:agent-interface",
        "search:jira:agent-interface",
        "write:jira:agent-interface",
      ],
      ATLASSIAN_ROVO_SCOPES,
      [],
    );

    expect(scopes).toEqual(ATLASSIAN_ROVO_SCOPES);
    expect(scopes).toContain("read:jira-work");
    expect(scopes).toContain("write:jira-work");
    expect(scopes).not.toContain("read:jira:agent-interface");
  });

  it("keeps the conservative generic protected-resource limit for other MCP providers", () => {
    const scopes = chooseMcpAuthorizationScopes(
      "https://example.com/mcp",
      [],
      Array.from({ length: 9 }, (_, index) => `scope:${index}`),
      [],
    );

    expect(scopes).toEqual([]);
  });

  it("continues to prefer an explicit bearer challenge for generic providers", () => {
    const scopes = chooseMcpAuthorizationScopes(
      "https://example.com/mcp",
      ["read:data"],
      ["read:data", "write:data"],
      [],
    );

    expect(scopes).toEqual(["read:data"]);
  });
});
