import { describe, expect, it } from "vitest";

import { PLUGIN_HUB_IPC } from "../shared/plugin-hub-api";
import { validatePluginHubIpcInvocation } from "./plugin-hub-ipc";

describe("Plugin Hub workspace skill IPC policy", () => {
  it("accepts exact workspace ids for read/reconcile and rejects malformed arguments", () => {
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.skillPolicy, ["workspace-a"])).toBeNull();
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.reconcileSkills, ["workspace-a"])).toBeNull();
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.skillPolicy, [])).toMatch(/exactly one argument/i);
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.reconcileSkills, ["../escape"])).toMatch(/invalid/i);
  });

  it("accepts bounded policy updates and fails closed on invalid modes or skill keys", () => {
    const valid = {
      workspaceId: "workspace-a",
      discovery: "automatic",
      use: "manual",
      install: "skills-only",
      include: ["dev/react-components"],
      exclude: ["dev/django-migrations"],
    };
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.setSkillPolicy, [valid])).toBeNull();
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.setSkillPolicy, [{
      ...valid,
      install: "everything",
    }])).toMatch(/install policy is invalid/i);
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.setSkillPolicy, [{
      ...valid,
      include: ["../escape"],
    }])).toMatch(/invalid/i);
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.setSkillPolicy, [{
      ...valid,
      include: Array.from({ length: 257 }, () => "dev/react-components"),
    }])).toMatch(/include list is invalid/i);
  });

  it("does not allow the new channels to bypass one-argument validation", () => {
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.setSkillPolicy, [])).toMatch(/exactly one argument/i);
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.skillPolicy, ["workspace-a", "workspace-b"])).toMatch(/exactly one argument/i);
    expect(validatePluginHubIpcInvocation(PLUGIN_HUB_IPC.reconcileSkills, [null])).toMatch(/invalid/i);
  });
});
