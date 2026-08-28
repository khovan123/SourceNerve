import path from "node:path";

import { app, nativeImage, type NativeImage } from "electron";

export function loadDesktopAppIcon(): NativeImage {
  const candidates = [
    path.join(process.resourcesPath, "icon.png"),
    path.join(app.getAppPath(), "assets", "generated", "icon.png"),
    path.join(process.cwd(), "assets", "generated", "icon.png"),
  ];

  for (const candidate of new Set(candidates)) {
    const image = nativeImage.createFromPath(candidate);
    if (!image.isEmpty()) return image;
  }

  return nativeImage.createFromDataURL(FALLBACK_APP_ICON_DATA_URL);
}

const FALLBACK_APP_ICON_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI2NCIgaGVpZ2h0PSI2NCIgdmlld0JveD0iMCAwIDY0IDY0Ij48cmVjdCB4PSI0IiB5PSI0IiB3aWR0aD0iNTYiIGhlaWdodD0iNTYiIHJ4PSIxNCIgZmlsbD0iIzM1NkFFNiIvPjxwYXRoIGQ9Ik0xNiAyMGg4djI0aDI0di04SDMyVjI4aDE2di04SDI0di00aC04djR6IiBmaWxsPSIjZmZmIi8+PC9zdmc+";
