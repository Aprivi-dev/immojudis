import { expect, test, type Page } from "@playwright/test";

/**
 * Essai gratuit à l'inscription, vu par un visiteur sur /login et /offres : ouvert (l'état lu dit
 * `active: true`), fermé (`active: false`) et en panne (503 : le visiteur ne lit ni promesse ni
 * erreur). L'état vient de `GET /api/launch-offer`, simulé ici.
 */

type State = "open" | "closed" | "down";

async function mock(page: Page, state: State) {
  await page.route("**/api/launch-offer*", (route) =>
    state === "down"
      ? route.fulfill({ status: 503, json: { ok: false, error: "Indisponible." } })
      : route.fulfill({ json: { active: state === "open" } }),
  );
  await page.route("**/api/billing/offer", (route) =>
    route.fulfill({
      json: { configured: false, trialDays: 7, trialAvailable: false, label: "59 € / mois" },
    }),
  );
  await page.route("https://ci.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
}

async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
}

test.describe("/login?mode=investor", () => {
  test("essai ouvert : la promesse de l'essai est lue avant l'inscription", async ({ page }) => {
    await mock(page, "open");
    await page.goto("/login?mode=investor");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const promise = page.getByTestId("login-free-promise");
    await expect(promise).toContainText("7 jours");
    await expect(promise).toContainText("sans carte bancaire");
    await expect(page.getByRole("button", { name: "Créer mon compte gratuit" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("essai fermé : aucune promesse d'essai, le compte gratuit reste proposé", async ({
    page,
  }) => {
    await mock(page, "closed");
    await page.goto("/login?mode=investor");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("login-free-promise")).not.toContainText("7 jours");
    await expect(page.getByTestId("login-launch-offer")).toHaveCount(0);
    await expect(page.getByTestId("login-launch-offer-column")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Créer mon compte gratuit" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("état illisible (503) : pas de promesse d'essai, pas d'erreur affichée", async ({
    page,
  }) => {
    await mock(page, "down");
    await page.goto("/login?mode=investor");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByTestId("login-free-promise")).not.toContainText("7 jours");
    await expect(page.getByTestId("login-launch-offer")).toHaveCount(0);
    await expect(page.locator("main [role=alert]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Créer mon compte gratuit" })).toBeVisible();
  });
});

test.describe("/offres", () => {
  test("essai ouvert : bandeau, encart dans la carte Analyse, aucun paiement proposé", async ({
    page,
  }) => {
    await mock(page, "open");
    await page.goto("/offres");
    await expect(page.getByTestId("launch-offer-banner")).toBeVisible();
    await expect(page.getByTestId("launch-offer-panel")).toContainText("7 jours");
    await expect(page.getByTestId("launch-offer-banner-placeholder")).toHaveCount(0);
    await expect(page.getByTestId("price-note")).toContainText("pas encore souscriptible");
    await expectNoHorizontalOverflow(page);
  });

  test("essai fermé : ni bandeau ni encart, le tarif prévu reste annoncé", async ({ page }) => {
    await mock(page, "closed");
    await page.goto("/offres");
    await expect(page.getByTestId("price-note")).toBeVisible();
    await expect(page.getByTestId("launch-offer-banner")).toHaveCount(0);
    await expect(page.getByTestId("launch-offer-panel")).toHaveCount(0);
    await expect(page.getByTestId("launch-offer-banner-placeholder")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test("état illisible (503) : retombe sur l'offre sans essai, sans bandeau figé", async ({
    page,
  }) => {
    await mock(page, "down");
    await page.goto("/offres");
    await expect(page.getByTestId("price-note")).toBeVisible();
    await expect(page.getByTestId("launch-offer-banner")).toHaveCount(0);
    await expect(page.getByTestId("launch-offer-panel")).toHaveCount(0);
    await expect(page.getByTestId("launch-offer-banner-placeholder")).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
});
