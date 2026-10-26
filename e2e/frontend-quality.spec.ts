import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mapPreviewRows, type PreviewSearchRow } from "@/lib/search/preview-search";

const PUBLIC_ROUTES = [
  "/",
  "/a-propos",
  "/contact",
  "/legal",
  "/privacy",
  "/offres",
  "/ventes-immobilieres-judiciaires",
  "/annonce-exemple",
  "/classement-des-annonces",
  "/sales",
  "/tribunaux",
  "/ressources",
  "/audiences-a-venir",
  "/methode-ecart-marche",
  "/methode-pepites",
  "/login",
] as const;

for (const route of PUBLIC_ROUTES) {
  test(`${route} reste lisible au clavier, avec contrôle Axe sur Chromium`, async ({
    page,
  }, testInfo) => {
    // Axe mesure la page au repos : sans animation, les blocs qui apparaissent au défilement
    // (accueil) sont déjà affichés, et leurs contrastes sont ceux que le visiteur lira.
    await page.emulateMedia({ reducedMotion: "reduce" });
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

/** Une vente du catalogue public, au format de la route `/api/catalogue/preview`. */
function previewRow(id: string, city: string, price: number, surface: number) {
  return {
    id,
    starting_price_eur: price,
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    city,
    department: "69",
    property_type: "apartment",
    sale_date: "2036-12-12T09:00:00.000Z",
    app_surface_m2: surface,
    app_surface_kind: "habitable",
    rooms_count: 3,
    bedrooms_count: 2,
    bathrooms_count: 1,
    latitude: 45.76,
    longitude: 4.83,
    thumbnail_url: null,
    total_count: 2,
  };
}

test("/sales avec des résultats : cartes, pagination et tri sans violation Axe sérieuse", async ({
  page,
}, testInfo) => {
  const rows = [
    previewRow("77000000-0000-4000-8000-0000000000b1", "Lyon", 60_000, 40),
    previewRow("77000000-0000-4000-8000-0000000000b2", "Villeurbanne", 96_000, 60),
  ];
  await page.route("**/api/catalogue/preview*", (route) =>
    route.fulfill({
      status: 200,
      json: { items: mapPreviewRows(rows as PreviewSearchRow[]), count: rows.length, mirrors: [] },
    }),
  );
  await page.route("https://ci.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: [] }),
  );

  await page.goto("/sales?city=Lyon");
  await expect(page.locator("h1:visible").first()).toBeVisible();
  await expect(page.getByText("Lyon", { exact: false }).first()).toBeVisible();

  if (testInfo.project.name.includes("chromium")) {
    const results = await new AxeBuilder({ page }).analyze();
    expect(
      results.violations.filter((violation) =>
        ["critical", "serious"].includes(violation.impact ?? ""),
      ),
    ).toEqual([]);
  }
});

test("la navigation mobile s’ouvre, reçoit le focus et se referme", async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.startsWith("mobile-"), "Contrôle réservé aux profils mobiles");

  await page.goto("/");
  const openButton = page.getByRole("button", { name: "Ouvrir le menu" });
  await openButton.click();

  const navigation = page.getByRole("dialog");
  await expect(navigation).toBeVisible();
  await expect(navigation.getByRole("link", { name: "Ventes", exact: true })).toBeVisible();

  await page
    .locator("#site-mobile-navigation")
    .getByRole("button", { name: "Fermer le menu" })
    .click();
  await expect(navigation).toBeHidden();
});

test("au clavier, Tab ne démarre pas la carte de /sales ; Entrée sur « Afficher la carte » la démarre et lui donne le focus", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop-chromium", "Carte du bureau, Tab vers les boutons");

  await page.goto("/sales");
  const preview = page.getByTestId("map-preview");
  const showMap = page.getByRole("button", { name: "Afficher la carte" });
  await expect(preview).toBeVisible();

  // Tab seul traverse la page jusqu'au bouton : la carte n'est pas demandée pour autant.
  let reached = false;
  for (let presses = 0; presses < 120 && !reached; presses += 1) {
    await page.keyboard.press("Tab");
    reached = await showMap.evaluate((element) => element === document.activeElement);
  }
  expect(reached, "Tab atteint le bouton « Afficher la carte »").toBe(true);
  await page.waitForTimeout(1000);
  await expect(preview).toBeVisible();
  await expect(showMap).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Carte des ventes" })).toBeFocused();
  await expect(page.getByText("Carte affichée", { exact: true })).toBeAttached();
});
