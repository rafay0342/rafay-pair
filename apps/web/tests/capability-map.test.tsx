import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CapabilitiesPage } from "../src/pages/CapabilitiesPage";
import { MovePage } from "../src/pages/MovePage";
import { TogetherPage } from "../src/pages/TogetherPage";
import { VitalsPage } from "../src/pages/VitalsPage";
import { CameraPoseController } from "../src/pose/CameraPoseController";

/**
 * The capability map is a promise to the user about what this client does.
 *
 * It went stale once: it said camera pose was "not part of this release" for a
 * release that shipped camera pose. A page that describes the product has to be
 * checked against the product rather than against itself, so these tests import
 * the surfaces it describes and assert the two agree.
 */
function capabilityRow(name: string): { state: string; detail: string } {
  const row = screen.getByRole("rowheader", { name }).closest("tr");
  if (!row) throw new Error(`No capability row named ${name}`);
  const cells = within(row).getAllByRole("cell");
  return {
    state: cells[0]?.textContent?.trim() ?? "",
    detail: cells[1]?.textContent?.trim() ?? "",
  };
}

describe("web capability map", () => {
  it("does not call a feature unsupported while the app routes to it", () => {
    render(<CapabilitiesPage />);

    // Each pair is a surface this client actually ships and the row that
    // describes it. Importing the surface is the coupling: delete the feature
    // and this test stops compiling rather than quietly disagreeing with the
    // page.
    const shipped: readonly (readonly [unknown, string])[] = [
      [MovePage, "Pose workouts"],
      [CameraPoseController, "Pose workouts"],
      [TogetherPage, "Together mode"],
      [VitalsPage, "Guided breathing"],
    ];

    for (const [surface, capability] of shipped) {
      expect(typeof surface).toBe("function");
      expect(capabilityRow(capability).state).not.toBe("unsupported");
    }
  });

  it("keeps the claims a browser genuinely cannot make", () => {
    render(<CapabilitiesPage />);

    // Not modesty: the rear torch and locked exposure a fingertip measurement
    // needs are not reliably available to a browser, and a pulse without them
    // would be a fabricated number.
    expect(capabilityRow("Phone-camera pulse").state).toBe("unsupported");
    expect(capabilityRow("Microphone breathing estimate").state).toBe(
      "unsupported",
    );
    expect(capabilityRow("Rafay AI voice").state).toBe("unsupported");
    expect(capabilityRow("HealthKit / Health Connect").state).toBe(
      "unsupported",
    );
  });

  it("never claims a blood pressure capability in any state", () => {
    render(<CapabilitiesPage />);
    // Absent by design: an "unsupported" row would still imply the product has
    // an opinion about estimating it from a camera. It does not.
    expect(screen.queryByText(/blood pressure/iu)).toBeNull();
  });
});
