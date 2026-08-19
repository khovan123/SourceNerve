import { describe, expect, it } from "vitest";

import { deriveProviderMetadata } from "./workspace-manager";

describe("Desktop workspace provider inference", () => {
  it("derives GitHub metadata from HTTPS and SCP-style SSH remotes", () => {
    expect(deriveProviderMetadata("https://github.com/openai/example.git")).toEqual({
      provider: "github",
      repository: "openai/example",
    });
    expect(deriveProviderMetadata("git@github.com:owner/repository.git")).toEqual({
      provider: "github",
      repository: "owner/repository",
    });
  });

  it("preserves GitLab subgroup slugs", () => {
    expect(deriveProviderMetadata("ssh://git@gitlab.com/group/subgroup/project.git")).toEqual({
      provider: "gitlab",
      repository: "group/subgroup/project",
    });
  });

  it("does not invent a provider for unsupported or malformed remotes", () => {
    expect(deriveProviderMetadata("git@example.internal:team/repo.git")).toEqual({});
    expect(deriveProviderMetadata("not a remote url")).toEqual({});
    expect(deriveProviderMetadata("https://github.com/one-segment")).toEqual({});
  });
});
