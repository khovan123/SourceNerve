import { contextBridge, ipcRenderer } from "electron";

import type { PluginHubApi } from "./shared/plugin-hub-api";
import { PLUGIN_HUB_IPC } from "./shared/plugin-hub-api";

const api: PluginHubApi = {
  list: () => ipcRenderer.invoke(PLUGIN_HUB_IPC.list),
  explore: () => ipcRenderer.invoke(PLUGIN_HUB_IPC.explore),
  reviewMarketplace: (catalogId) => ipcRenderer.invoke(PLUGIN_HUB_IPC.reviewMarketplace, catalogId),
  inspectLocal: (root) => ipcRenderer.invoke(PLUGIN_HUB_IPC.inspectLocal, root),
  pickLocal: () => ipcRenderer.invoke(PLUGIN_HUB_IPC.pickLocal),
  installLocal: (root) => ipcRenderer.invoke(PLUGIN_HUB_IPC.installLocal, root),
  enable: (pluginId) => ipcRenderer.invoke(PLUGIN_HUB_IPC.enable, pluginId),
  disable: (pluginId) => ipcRenderer.invoke(PLUGIN_HUB_IPC.disable, pluginId),
  remove: (pluginId) => ipcRenderer.invoke(PLUGIN_HUB_IPC.remove, pluginId),
};

contextBridge.exposeInMainWorld("sourcenervePluginHub", api);
