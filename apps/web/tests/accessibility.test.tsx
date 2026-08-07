import { render, screen, waitFor } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { MemoryRouter } from "../src/routing/Router";
import { AuthProvider } from "../src/state/AuthContext";

function renderApplication(): void {
  render(
    <MemoryRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("accessible entry experience", () => {
  it("has no detectable axe violations on the sign-in route", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ title: "Unauthenticated", status: 401 }), {
        status: 401,
        headers: { "Content-Type": "application/problem+json" },
      }),
    );
    renderApplication();
    await screen.findByRole("heading", { name: /care should feel close/iu });

    const results = await axe.run(document.body);
    expect(results.violations).toEqual([]);
  });

  it("provides a keyboard-operable registration form with explicit labels", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ title: "Unauthenticated", status: 401 }), {
        status: 401,
        headers: { "Content-Type": "application/problem+json" },
      }),
    );
    renderApplication();
    const createAccountTabs = await screen.findAllByRole("button", {
      name: "Create account",
    });
    createAccountTabs[0]?.click();

    await waitFor(() =>
      expect(screen.getByLabelText("Your name")).toBeVisible(),
    );
    expect(screen.getByLabelText("Email")).toHaveAttribute(
      "autocomplete",
      "email",
    );
    expect(screen.getByLabelText("Password")).toHaveAttribute(
      "autocomplete",
      "new-password",
    );
  });
});
