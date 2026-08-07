import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import {
  Link,
  MemoryRouter,
  NavLink,
  resolveSameOriginPath,
  usePathname,
} from "../src/routing/Router";

function RouteProbe(): React.JSX.Element {
  return <output aria-label="Current route">{usePathname()}</output>;
}

describe("same-origin router", () => {
  it("navigates with accessible links and updates active state", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <nav>
          <NavLink to="/" end>
            Home
          </NavLink>
          <NavLink to="/care">Care</NavLink>
        </nav>
        <RouteProbe />
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await user.click(screen.getByRole("link", { name: "Care" }));
    expect(screen.getByLabelText("Current route")).toHaveTextContent("/care");
    expect(screen.getByRole("link", { name: "Care" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("rejects protocol-relative, external, and non-absolute destinations", () => {
    const origin = "https://app.rafaypair.com";
    expect(() => resolveSameOriginPath("//evil.example", origin)).toThrow(
      /same-origin/u,
    );
    expect(() =>
      resolveSameOriginPath("https://evil.example/care", origin),
    ).toThrow(/same-origin/u);
    expect(() => resolveSameOriginPath("care", origin)).toThrow(/absolute/u);
    expect(resolveSameOriginPath("/care?source=home#request", origin)).toBe(
      "/care?source=home#request",
    );
  });

  it("renders a normal href so new-tab and keyboard behavior stay native", () => {
    render(
      <MemoryRouter>
        <Link to="/privacy">Privacy</Link>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute(
      "href",
      "/privacy",
    );
  });
});
