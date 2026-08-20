import { describe, expect, it } from "vitest";

import { withPluginChallenge } from "./daemon-bootstrap";

describe("managed daemon plugin challenge environment", () => {
  it("adds the secure challenge only to the child environment", () => {
    const token = "openai-domain-challenge_abc.123";
    const input = { SOURCENERVE_CONFIG: "/managed/sourcenerve.toml" };
    const result = withPluginChallenge(input, token);

    expect(result).toEqual({
      SOURCENERVE_CONFIG: "/managed/sourcenerve.toml",
      SOURCENERVE_OPENAI_APPS_CHALLENGE: token,
    });
    expect(input).not.toHaveProperty("SOURCENERVE_OPENAI_APPS_CHALLENGE");
  });

  it("rejects whitespace, control characters, and oversized challenge values", () => {
    expect(() => withPluginChallenge({}, "contains space")).toThrow(/ASCII graphic/);
    expect(() => withPluginChallenge({}, "line\nbreak")).toThrow(/ASCII graphic/);
    expect(() => withPluginChallenge({}, "x".repeat(1025))).toThrow(/1-1024/);
  });

  it("does not add a challenge variable when none is configured", () => {
    expect(withPluginChallenge({ TEST: "1" }, null)).toEqual({ TEST: "1" });
  });
});
