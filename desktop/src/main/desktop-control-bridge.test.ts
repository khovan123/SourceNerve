import { describe, expect, it } from "vitest";

import { macKeyScript, mapScreenshotPoint, mapScreenshotPointToPortal, portalKeysymSequence, windowsKeyChord, windowsLiteralKeys, ydotoolKeySequence } from "./desktop-control-bridge";

describe("mapScreenshotPoint", () => {
  it("maps thumbnail pixels into absolute display coordinates", () => {
    expect(mapScreenshotPoint(640, 360, {
      displayId: "2",
      bounds: { x: -1920, y: 120, width: 1920, height: 1080 },
      imageSize: { width: 1280, height: 720 },
    })).toEqual({ x: -960, y: 660 });
  });

  it("rejects coordinates outside the captured image", () => {
    const geometry = {
      displayId: "1",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      imageSize: { width: 1280, height: 720 },
    };
    expect(() => mapScreenshotPoint(1280, 0, geometry)).toThrow(/outside the captured image/);
    expect(() => mapScreenshotPoint(0, 720, geometry)).toThrow(/outside the captured image/);
  });
});

describe("mapScreenshotPointToPortal", () => {
  it("maps screenshot pixels into the matching portal monitor stream", () => {
    const geometry = {
      displayId: "2",
      bounds: { x: -1920, y: 120, width: 1920, height: 1080 },
      imageSize: { width: 1280, height: 720 },
    };
    const streams = [
      { nodeId: 41, position: { x: 0, y: 0 }, size: { width: 2560, height: 1440 } },
      { nodeId: 42, position: { x: -1920, y: 120 }, size: { width: 1920, height: 1080 } },
    ];
    expect(mapScreenshotPointToPortal(640, 360, geometry, streams)).toEqual({
      stream: 42,
      x: 960,
      y: 540,
    });
  });

  it("fails closed when multiple portal streams cannot be matched", () => {
    const geometry = {
      displayId: "9",
      bounds: { x: 5000, y: 5000, width: 1920, height: 1080 },
      imageSize: { width: 1280, height: 720 },
    };
    const streams = [
      { nodeId: 1, position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } },
      { nodeId: 2, position: { x: 1920, y: 0 }, size: { width: 1920, height: 1080 } },
    ];
    expect(() => mapScreenshotPointToPortal(10, 10, geometry, streams)).toThrow(/could not be matched/);
  });
});

describe("desktop keyboard encoders", () => {
  it("builds macOS modifier chords", () => {
    expect(macKeyScript("Command+Shift+L")).toBe(
      'tell application "System Events" to keystroke "L" using {command down, shift down}',
    );
    expect(macKeyScript("Control+Enter")).toBe(
      'tell application "System Events" to key code 36 using {control down}',
    );
  });

  it("builds Windows SendKeys chords and escapes literal text", () => {
    expect(windowsKeyChord("Control+Shift+A")).toBe("^+A");
    expect(windowsKeyChord("Alt+F4")).toBe("%{F4}");
    expect(windowsLiteralKeys("a+b^c\n")).toBe("a{+}b{^}c{ENTER}");
    expect(() => windowsKeyChord("Meta+L")).toThrow(/Meta\/Super/);
  });
});

describe("portalKeysymSequence", () => {
  it("builds balanced Wayland portal keysyms for modifier chords", () => {
    expect(portalKeysymSequence("Control+Shift+A")).toEqual([
      { keysym: 0xffe3, state: 1 },
      { keysym: 0xffe1, state: 1 },
      { keysym: 0x41, state: 1 },
      { keysym: 0x41, state: 0 },
      { keysym: 0xffe1, state: 0 },
      { keysym: 0xffe3, state: 0 },
    ]);
  });

  it("maps named and Unicode keys without evdev offsets", () => {
    expect(portalKeysymSequence("Enter")).toEqual([
      { keysym: 0xff0d, state: 1 },
      { keysym: 0xff0d, state: 0 },
    ]);
    expect(portalKeysymSequence("é")).toEqual([
      { keysym: 0xe9, state: 1 },
      { keysym: 0xe9, state: 0 },
    ]);
  });
});

describe("ydotoolKeySequence", () => {
  it("maps a simple key to Linux key down/up events", () => {
    expect(ydotoolKeySequence("Enter")).toEqual(["28:1", "28:0"]);
  });

  it("maps modifier combinations with balanced press and release order", () => {
    expect(ydotoolKeySequence("Control+Shift+A")).toEqual([
      "29:1",
      "42:1",
      "30:1",
      "30:0",
      "42:0",
      "29:0",
    ]);
  });

  it("rejects unsupported or modifier-only combinations", () => {
    expect(() => ydotoolKeySequence("Control")).toThrow(/Unsupported Linux key combination/);
    expect(() => ydotoolKeySequence("Control+DefinitelyNotAKey")).toThrow(/Unsupported Linux key/);
  });
});
