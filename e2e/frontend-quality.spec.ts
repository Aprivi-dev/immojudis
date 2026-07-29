import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const PUBLIC_ROUTES = [
  "/",
  "/a-propos",
  "/contact",
  "/legal",
  "/privacy",
  "/accompagnement",
  "/ventes-immobilieres-judiciaires",
  "/annonce-exemple",
  "/login",
] as const;

for (const route of PUBLIC_ROUTES) {
  test(`${route} reste lisible au clavier, avec contrôle Axe sur Chromium`, async ({
    page,
  }, testInfo) => {
    await page.goto(route);
    await expect(page.locator("h1:visible").first()).toBeVisible();

    if (testInfo.project.name.includes("webkit")) {
      await page.locator("a:visible, button:visible, input:visible").first().focus();
    } else {
      await page.keyboard.press("Tab");
    }
    await expect(page.locator(":focus")).toBeVisible();

    if (testInfo.project.name.includes("chromium")) {
      const results = await new AxeBuilder({ page }).analyze();
      expect(
        results.violations.filter((violation) =>
          ["critical", "serious"].includes(violation.impact ?? ""),
        ),
      ).toEqual([]);
    }
  });
}

test("la navigation mobile s’ouvre, reçoit le focus et se referme", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "Contrôle réservé aux profils mobiles");

  await page.goto("/");
  const openButton = page.getByRole("button", { name: "Ouvrir le menu" });
  await openButton.click();

  const navigation = page.getByRole("dialog");
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Rechercher un bien" })).toBeVisible();

  await page
    .locator("#home-mobile-navigation")
    .getByRole("button", { name: "Fermer le menu" })
    .click();
  await expect(navigation).toBeHidden();
});
