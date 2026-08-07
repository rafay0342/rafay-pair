import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("RafayPair Milestone 1 live API", () => {
  test("registers two users, pairs, grants consent, exchanges care, pauses, and disconnects", async ({
    browser,
  }) => {
    test.setTimeout(60_000);
    const unique = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
    const password = `Live-${unique}-Aa!42`;
    const firstContext = await browser.newContext();
    const secondContext = await browser.newContext();
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();

    const openSection = async (
      page: typeof first,
      name: "Care" | "Consent" | "Pair" | "Privacy",
    ): Promise<void> => {
      const visibleNavigation = page
        .getByRole("navigation", { name: "Primary navigation" })
        .filter({ visible: true });
      await visibleNavigation.getByRole("link", { name, exact: true }).click();
    };

    const register = async (
      page: typeof first,
      name: string,
      email: string,
    ): Promise<void> => {
      await page.goto("/");
      await page
        .getByRole("button", { name: "Create account" })
        .first()
        .click();
      await page.getByLabel("Your name").fill(name);
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page
        .locator("form")
        .getByRole("button", { name: "Create account" })
        .click();
      await expect(
        page.getByRole("heading", { name: new RegExp(`Hello, ${name}`, "u") }),
      ).toBeVisible();
    };

    try {
      await register(first, "First Partner", `first-${unique}@example.test`);
      await register(second, "Second Partner", `second-${unique}@example.test`);

      await openSection(first, "Pair");
      await first.getByRole("button", { name: "Create pair code" }).click();
      const codeText = await first.locator(".invite-code").innerText();
      const code = codeText.split(/\s/u)[0] ?? "";
      expect(code.length).toBeGreaterThanOrEqual(6);

      await openSection(second, "Pair");
      await second.getByLabel("Pair code").fill(code);
      await second.getByRole("button", { name: "Join pair" }).click();
      await expect(
        second.getByRole("heading", { name: "First Partner" }),
      ).toBeVisible();

      await first.reload();
      await expect(
        first.getByRole("heading", { name: "Second Partner", exact: true }),
      ).toBeVisible();

      for (const page of [first, second]) {
        await openSection(page, "Consent");
        const careSwitch = page.getByRole("switch", {
          name: "Allow Care requests",
        });
        if (!(await careSwitch.isChecked())) await careSwitch.click();
        await expect(careSwitch).toBeChecked();
      }

      await openSection(first, "Care");
      await first.getByLabel("Check in with me").check();
      await first.getByRole("button", { name: "Send request" }).click();
      await expect(first.getByText(/request was sent/u)).toBeVisible();

      await openSection(second, "Care");
      await expect(
        second.getByRole("heading", { name: "Check in with me" }),
      ).toBeVisible();
      await second.getByRole("button", { name: "Accept" }).click();
      await expect(second.getByText("accepted")).toBeVisible();

      await openSection(first, "Privacy");
      await first
        .getByRole("button", { name: "Pause all partner sharing" })
        .click();
      await expect(
        first.getByRole("heading", { name: "Partner sharing is paused" }),
      ).toBeVisible();
      // The pause acts locally first; reloading before the durable intent and
      // the server confirmation land would legitimately lose the pause. Wait
      // for the confirmed state (no pending banner) before testing hydration.
      await expect(
        first.getByText("Paused here; server confirmation is pending"),
      ).toBeHidden();

      await first.reload();
      await expect(
        first.getByRole("heading", { name: "Partner sharing is paused" }),
      ).toBeVisible();

      await openSection(first, "Pair");
      await first.getByRole("button", { name: "Disconnect pair" }).click();
      await first.getByLabel("Type DISCONNECT to confirm").fill("DISCONNECT");
      await first
        .getByRole("button", { name: "Revoke and disconnect" })
        .click();
      await expect(
        first.getByText(/all partner access was revoked/u),
      ).toBeVisible();
    } finally {
      await firstContext.close();
      await secondContext.close();
    }
  });

  test("sign-in page passes automated accessibility checks", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: /care should feel close/iu }),
    ).toBeVisible();
    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations).toEqual([]);
  });
});
