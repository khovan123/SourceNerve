import { describe, expect, it } from "vitest";

import { parseDbusNames, validateMediaUri } from "./desktop-control-media";

describe("desktop-control background media helpers", () => {
  it("extracts and deduplicates MPRIS bus names without accepting arbitrary output", () => {
    const output = "(['org.freedesktop.DBus', 'org.mpris.MediaPlayer2.spotify', 'org.mpris.MediaPlayer2.vlc', 'org.mpris.MediaPlayer2.spotify'],)";
    expect(parseDbusNames(output)).toEqual([
      "org.freedesktop.DBus",
      "org.mpris.MediaPlayer2.spotify",
      "org.mpris.MediaPlayer2.vlc",
    ]);
  });

  it("allows bounded media URIs and rejects command-shaped or unsupported schemes", () => {
    expect(validateMediaUri("spotify:track:4uLU6hMCjMI75M1A2tKUQC")).toBe("spotify:track:4uLU6hMCjMI75M1A2tKUQC");
    expect(validateMediaUri("https://open.spotify.com/track/example")).toBe("https://open.spotify.com/track/example");
    expect(() => validateMediaUri("javascript:alert(1)")).toThrow("scheme is not allowed");
    expect(() => validateMediaUri("spotify:track:ok\n--dest evil")).toThrow("invalid");
  });
});
