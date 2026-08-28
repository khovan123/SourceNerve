import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp") },
  shell: { beep: vi.fn() },
}));

import { buildNotificationWave } from "./notification-sound";

describe("notification sound", () => {
  it("builds a valid non-empty PCM WAV chime", () => {
    const wave = buildNotificationWave();
    expect(wave.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wave.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wave.subarray(36, 40).toString("ascii")).toBe("data");
    expect(wave.readUInt16LE(20)).toBe(1);
    expect(wave.readUInt16LE(22)).toBe(1);
    expect(wave.readUInt32LE(24)).toBe(44_100);
    expect(wave.readUInt16LE(34)).toBe(16);
    expect(wave.length).toBeGreaterThan(10_000);
    expect(wave.subarray(44).some((value) => value !== 0)).toBe(true);
  });
});
