import { access } from "node:fs/promises";

import electronPath from "electron";

if (typeof electronPath !== "string" || !electronPath.trim()) {
  throw new Error("Electron did not resolve to an executable path");
}

await access(electronPath);
console.log(`verified Electron runtime: ${electronPath}`);
