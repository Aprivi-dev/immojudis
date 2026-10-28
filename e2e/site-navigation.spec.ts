import { expect, test, type Page } from "@playwright/test";

/**
 * Barre de navigation en pilule : bascule entre le menu (1023 px) et la navigation du bureau
 * (1024 px), page courante annoncée, et usage au clavier du menu (focus piégé, Échap).
 */

const mainNavigation = (page: Page) =>
  page.getByRole("navigation", { name: "Navigation principale" });
// Sélecteur direct : le dialogue ouvert rend le reste de la page inerte, donc absent de l'arbre d'accessibilité.
const menuButton = (page: Page) => page.locator('button[aria-label="Ouvrir le menu"]');

test.describe("à 1024 px : la navigation du bureau", () => {
  test.use({ viewport: { width: 1024, height: 720 } });

  test("remplace le bouton de menu et marque la page courante", async ({ page }) => {
    await page.goto("/offres");
    await expect(mainNavigation(page)).toBeVisible();
    await expect(menuButton(page)).toBeHidden();
    const current = mainNavigation(page).locator("a[aria-current=page]");
    await expect(current).toHaveCount(1);
    await expect(current).toHaveText("Offres");
  });

  test("montre au clavier un anneau de focus d'au moins 2 px", async ({ page }) => {
    await page.goto("/offres");
    await expect(mainNavigation(page)).toBeVisible();
    let ring = { style: "none", width: 0 };
    for (let press = 0; press < 12; press += 1) {
      await page.keyboard.press("Tab");
      const inside = await page.evaluate(
        () => !!document.activeElement?.closest('nav[aria-label="Navigation principale"]'),
      );
      if (!inside) continue;
      ring = await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement as Element);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
      });
      break;
    }
    expect(ring.style).not.toBe("none");
    expect(ring.width).toBeGreaterThanOrEqual(2);
  });
});

test.describe("à 1023 px : le menu", () => {
  test.use({ viewport: { width: 1023, height: 720 } });

  test("remplace la navigation du bureau", async ({ page }) => {
    await page.goto("/offres");
    await expect(menuButton(page)).toBeVisible();
    await expect(mainNavigation(page)).toBeHidden();
  });

  test("s'ouvre en dialogue, garde le focus dedans, se ferme à Échap et rend le focus au bouton", async ({
    page,
  }) => {
    await page.goto("/offres");
    const opener = menuButton(page);
    await expect(async () => {
      await opener.click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1500 });
    }).toPass();
    await expect(opener).toHaveAttribute("aria-expanded", "true");
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest("[role=dialog]")))
      .toBe(true);

    // Tab ne sort jamais du dialogue.
    for (let press = 0; press < 25; press += 1) {
      await page.keyboard.press("Tab");
      expect(await page.evaluate(() => !!document.activeElement?.closest("[role=dialog]"))).toBe(
        true,
      );
    }

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAttribute("aria-expanded", "false");
  });

  test("un lien du menu ferme le menu et « Retour » ne le rouvre pas", async ({ page }) => {
    await page.goto("/offres");
    await expect(async () => {
      await menuButton(page).click();
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 1500 });
    }).toPass();
    await page.getByRole("dialog").getByRole("link", { name: "Tribunaux", exact: true }).click();
    await expect(page).toHaveURL(/\/tribunaux/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.goBack();
    await expect(page).toHaveURL(/\/offres/);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});
