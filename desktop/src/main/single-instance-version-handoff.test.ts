import { describe, expect, it } from "vitest";

import {
  shouldRestartForNewerInstalledInstance,
  sourceNerveSingleInstanceData,
} from "./single-instance-version-handoff";

describe("single-instance version handoff", () => {
  it("requests a restart when a newer installed Desktop instance is launched", () => {
    expect(
      shouldRestartForNewerInstalledInstance(
        "0.1.27",
        sourceNerveSingleInstanceData("0.1.28"),
      ),
    ).toBe(true);
  });

  it("does not restart for the same or an older Desktop version", () => {
    expect(
      shouldRestartForNewerInstalledInstance(
        "0.1.27",
        sourceNerveSingleInstanceData("0.1.27"),
      ),
    ).toBe(false);
    expect(
      shouldRestartForNewerInstalledInstance(
        "0.1.27",
        sourceNerveSingleInstanceData("0.1.26"),
      ),
    ).toBe(false);
  });

  it("fails closed for malformed second-instance metadata", () => {
    expect(shouldRestartForNewerInstalledInstance("0.1.27", null)).toBe(false);
    expect(shouldRestartForNewerInstalledInstance("0.1.27", {})).toBe(false);
    expect(
      shouldRestartForNewerInstalledInstance("0.1.27", {
        sourceNerveDesktopVersion: "0.1.28-beta.1",
      }),
    ).toBe(false);
    expect(
      shouldRestartForNewerInstalledInstance("dev", {
        sourceNerveDesktopVersion: "0.1.28",
      }),
    ).toBe(false);
  });

  it("handles semantic version segment boundaries", () => {
    expect(
      shouldRestartForNewerInstalledInstance(
        "0.9.99",
        sourceNerveSingleInstanceData("0.10.0"),
      ),
    ).toBe(true);
    expect(
      shouldRestartForNewerInstalledInstance(
        "1.0.0",
        sourceNerveSingleInstanceData("0.99.99"),
      ),
    ).toBe(false);
  });
});
