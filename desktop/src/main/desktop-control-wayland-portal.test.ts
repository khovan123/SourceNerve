import { describe, expect, it } from "vitest";

import { parseProbe, parseSession } from "./desktop-control-wayland-portal";

describe("WaylandRemoteDesktopPortal parsing", () => {
  it("accepts a portal probe with keyboard, pointer, and monitor capture", () => {
    expect(parseProbe({
      availableDeviceTypes: 7,
      version: 2,
      keyboard: true,
      pointer: true,
      screenCastMonitor: true,
      screenCastVersion: 6,
    })).toEqual({
      availableDeviceTypes: 7,
      version: 2,
      keyboard: true,
      pointer: true,
      screenCastMonitor: true,
      screenCastVersion: 6,
    });
  });

  it("rejects malformed portal metadata", () => {
    expect(() => parseProbe({ availableDeviceTypes: "bad", version: 2 })).toThrow(/invalid device metadata/);
    expect(() => parseProbe({
      availableDeviceTypes: 3,
      version: 2,
      keyboard: true,
      pointer: true,
      screenCastMonitor: true,
      screenCastVersion: "bad",
    })).toThrow(/invalid ScreenCast metadata/);
  });

  it("parses monitor stream geometry returned by RemoteDesktop Start", () => {
    expect(parseSession({
      devices: 3,
      streams: [[42, { position: [-1920, 120], size: [1920, 1080], source_type: 1 }]],
    })).toEqual({
      devices: 3,
      streams: [
        { nodeId: 42, position: { x: -1920, y: 120 }, size: { width: 1920, height: 1080 } },
      ],
    });
  });

  it("rejects sessions without usable monitor streams", () => {
    expect(() => parseSession({ devices: 3, streams: [] })).toThrow(/no monitor streams/);
    expect(() => parseSession({ devices: 3, streams: [["bad", {}]] })).toThrow(/stream id is invalid/);
  });
});
