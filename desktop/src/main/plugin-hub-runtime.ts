import type { McpExtensionManager } from "./mcp-extension-manager";
import type { PluginRuntimeMaterialization, PluginRuntimeMaterializer } from "./plugin-manager";

interface InternalLoopbackClient {
  request(
    path: string,
    options: { method: "GET" | "POST"; body?: object },
  ): Promise<unknown>;
}

export function createPluginRuntimeMaterializer(
  manager: McpExtensionManager,
): PluginRuntimeMaterializer {
  const client = internalClient(manager);
  return {
    async materialize(input: PluginRuntimeMaterialization): Promise<void> {
      await client.request("/api/v1/plugin-hub/materialize", {
        method: "POST",
        body: {
          skills: input.skills.map((skill) => ({
            plugin_id: skill.pluginId,
            plugin_name: skill.pluginName,
            plugin_version: skill.pluginVersion,
            ...(skill.publisher ? { publisher: skill.publisher } : {}),
            skill_id: skill.skillId,
            skill_name: skill.skillName,
            ...(skill.description ? { description: skill.description } : {}),
            content_hash: skill.contentHash,
            content: skill.content,
          })),
          harness_extensions: input.harnessExtensions.map(({ pluginId, pluginName, pluginVersion, extension }) => ({
            plugin_id: pluginId,
            plugin_name: pluginName,
            plugin_version: pluginVersion,
            config_hash: extension.configHash,
            policy_interceptors: extension.policyInterceptors.map((policy) => ({
              id: policy.id,
              target: policy.target.kind === "skill"
                ? { kind: "skill", skill_id: policy.target.skillId }
                : { kind: "mcp" },
              decision: policy.decision,
            })),
            job_providers: extension.jobProviders.map((provider) => ({
              id: provider.id,
              runtime: provider.runtime,
            })),
            sandbox_providers: extension.sandboxProviders.map((provider) => ({
              id: provider.id,
              modes: provider.modes,
              enforcement: provider.enforcement,
            })),
            context_providers: extension.contextProviders.map((provider) => ({
              id: provider.id,
              skill_id: provider.skillId,
            })),
            event_observers: extension.eventObservers.map((observer) => ({
              id: observer.id,
              events: observer.events,
              mode: observer.mode,
            })),
          })),
          mcp_ownership: input.mcpOwnership.map((record) => ({
            extension_id: record.extensionId,
            owners: record.owners,
          })),
        },
      });
    },
  };
}

function internalClient(manager: McpExtensionManager): InternalLoopbackClient {
  // McpExtensionManager intentionally owns the only authenticated loopback client.
  // Keep this capability inside Electron Main and never expose it to Renderer.
  const value = Reflect.get(manager as object, "client") as unknown;
  if (!value || typeof value !== "object") {
    throw new Error("MCP extension loopback client is unavailable for Plugin Hub runtime sync");
  }
  const request = Reflect.get(value, "request") as unknown;
  if (typeof request !== "function") {
    throw new Error("MCP extension loopback client cannot materialize Plugin Hub runtime state");
  }
  return {
    request: (path, options) =>
      (request as (this: object, path: string, options: { method: "GET" | "POST"; body?: object }) => Promise<unknown>)
        .call(value, path, options),
  };
}
