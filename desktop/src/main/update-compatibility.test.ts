import { describe, expect, it } from "vitest";

import {
  compareSemver,
  updateReleaseFromInfo,
  updaterChannelForArch,
} from "./update-compatibility";

describe("Desktop update compatibility", () => {
  it("accepts a newer stable release with matching daemon and profile schema", () => {
    expect(
      updateReleaseFromInfo(
        {
          version: "0.2.0",
          releaseDate: "2026-08-20T00:00:00.000Z",
          releaseNotes: "Safer updater",
          sourcenerve: { daemonVersion: "0.2.0", profileSchemaVersion: 1 },
        },
        "0.1.0",
      ),
    ).toMatchObject({
      version: "0.2.0",
      daemonVersion: "0.2.0",
      profileSchemaVersion: 1,
      releaseNotes: "Safer updater",
    });
  });

  it("normalizes GitHub HTML release notes into readable plain text", () => {
    const release = updateReleaseFromInfo(
      {
        version: "0.2.0",
        releaseNotes: [
          {
            version: "0.2.0",
            note: [
              "<h2>What's Changed</h2>",
              "<ul>",
              '<li>fix updater by <a href="https://github.com/example">@example</a> in <a href="https://github.com/example/repo/pull/1">#1</a></li>',
              "</ul>",
              '<p><strong>Full Changelog</strong>: <a href="https://github.com/example/repo/compare/v1...v2"><tt>v1...v2</tt></a></p>',
              "<script>alert('ignored')</script>",
            ].join(""),
          },
        ],
        sourcenerve: { daemonVersion: "0.2.0", profileSchemaVersion: 1 },
      },
      "0.1.0",
    );

    expect(release.releaseNotes).toBe(
      [
        "What's Changed",
        "",
        "• fix updater by @example in #1",
        "",
        "Full Changelog: v1...v2",
      ].join("\n"),
    );
    expect(release.releaseNotes).not.toMatch(/<\/?[a-z]|alert\(/i);
  });

  it("rejects downgrade and same-version metadata", () => {
    for (const version of ["0.1.0", "0.0.9"]) {
      expect(() =>
        updateReleaseFromInfo(
          {
            version,
            sourcenerve: { daemonVersion: version, profileSchemaVersion: 1 },
          },
          "0.1.0",
        ),
      ).toThrow(/newer Desktop version/);
    }
  });

  it("rejects prerelease metadata on the stable channel", () => {
    expect(() =>
      updateReleaseFromInfo(
        {
          version: "0.2.0-beta.1",
          sourcenerve: { daemonVersion: "0.2.0-beta.1", profileSchemaVersion: 1 },
        },
        "0.1.0",
      ),
    ).toThrow(/invalid stable Desktop version/);
  });

  it("rejects a daemon version mismatch", () => {
    expect(() =>
      updateReleaseFromInfo(
        {
          version: "0.2.0",
          sourcenerve: { daemonVersion: "0.1.9", profileSchemaVersion: 1 },
        },
        "0.1.0",
      ),
    ).toThrow(/Desktop and daemon versions do not match/);
  });

  it("rejects an unsupported product profile schema", () => {
    expect(() =>
      updateReleaseFromInfo(
        {
          version: "0.2.0",
          sourcenerve: { daemonVersion: "0.2.0", profileSchemaVersion: 2 },
        },
        "0.1.0",
      ),
    ).toThrow(/unsupported product profile schema/);
  });

  it("uses architecture-specific stable updater channels", () => {
    expect(updaterChannelForArch("x64")).toBe("latest-x64");
    expect(updaterChannelForArch("arm64")).toBe("latest-arm64");
    expect(() => updaterChannelForArch("../x64")).toThrow(/invalid updater architecture/);
  });

  it("orders stable semantic versions numerically", () => {
    expect(compareSemver("1.10.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
  });
});
