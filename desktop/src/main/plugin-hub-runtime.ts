import type { McpExtensionManager } from "./mcp-extension-manager";
import type { PluginRuntimeMaterializer, PluginRuntimeSkill } from "./plugin-manager";

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
    async materialize(skills: PluginRuntimeSkill[]): Promise<void> {
      await client.request("/api/v1/plugin-hub/materialize", {
        method: "POST",
        body: {
          skills: skills.map((skill) => ({
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
