import { expect, test, type Page } from "@playwright/test";
import { mapPreviewRows, type PreviewSearchRow } from "@/lib/search/preview-search";

/**
 * Navigation de /sales : « Retour » du navigateur (page, carte mobile, fiche) et liens d'évitement.
 * Le catalogue est servi par la route d'aperçu simulée ci-dessous, sur 3 pages de 24 annonces.
 */

/** La vente que le serveur de test sait servir (e2e/support/server-fetch-mock.cjs). */
const KNOWN_SALE = "11111111-1111-4111-8111-111111111111";
const TOTAL = 60;
const PAGE_SIZE = 24;

function previewRow(index: number): PreviewSearchRow {
  const id =
    index === PAGE_SIZE
      ? KNOWN_SALE
      : `78000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  return {
    id,
    starting_price_eur: 60_000 + index * 1000,
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    city: `Ville ${index + 1}`,
    department: "69",
    property_type: "apartment",
    sale_date: "2099-12-12T09:00:00.000Z",
    app_surface_m2: 40 + (index % 30),
    app_surface_kind: "habitable",
    rooms_count: 3,
    bedrooms_count: 2,
    bathrooms_count: 1,
    latitude: 45.76,
    longitude: 4.83,
    thumbnail_url: null,
    total_count: TOTAL,
  } as unknown as PreviewSearchRow;
}

async function mockCatalogue(page: Page) {
  await page.route("**/api/catalogue/preview*", async (route) => {
    const url = new URL(route.request().url());
    const pageNumber = Number(url.searchParams.get("page") ?? "1");
    const first = (pageNumber - 1) * PAGE_SIZE;
    const rows = Array.from({ length: Math.max(0, Math.min(PAGE_SIZE, TOTAL - first)) }, (_, i) =>
      previewRow(first + i),
    );
    await route.fulfill({
      status: 200,
      json: { items: mapPreviewRows(rows), count: TOTAL, mirrors: [] },
    });
  });
  await page.route("https://ci.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
}

test.describe("« Retour » sur /sales", () => {
  test("défait le changement de page au lieu de quitter la recherche", async ({ page }) => {
    await mockCatalogue(page);
    await page.goto("/sales");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    // Le premier clic peut précéder l'hydratation (le lien se suit alors comme un lien ordinaire).
    await expect(async () => {
      await page.getByRole("link", { name: "Page suivante" }).click();
      await expect(page).toHaveURL(/[?&]page=2(&|$)/, { timeout: 1000 });
    }).toPass();

    await page.goBack();
    await expect(page).toHaveURL(/\/sales$/);
    await expect(page.getByRole("link", { name: "Page suivante" })).toBeVisible();
  });

  test("revient à la page 2 et au défilement après avoir ouvert une fiche", async ({ page }) => {
    await mockCatalogue(page);
    await page.goto("/sales?page=2");
    const saleLink = page.locator(`a[href^="/sales/${KNOWN_SALE}"]`).first();
    await expect(saleLink).toBeAttached();
    // Les liens du HTML n'ont pas de ?from= : l'origine s'ajoute quand on approche le lien.
    expect(await saleLink.getAttribute("href")).toBe(`/sales/${KNOWN_SALE}`);

    await saleLink.scrollIntoViewIfNeeded();
    const scrolledTo = await page.evaluate(() => window.scrollY);
    expect(scrolledTo).toBeGreaterThan(0);

    await saleLink.click();
    await expect(page).toHaveURL(new RegExp(`/sales/${KNOWN_SALE}`));
    // Le « Retour aux ventes » de la fiche ramène à la même page du catalogue.
    const back = page.getByRole("link", { name: /Retour aux ventes/ });
    await expect(back).toHaveAttribute("href", "/sales?page=2");

    await page.goBack();
    await expect(page).toHaveURL(/\/sales\?page=2$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(scrolledTo / 2);
  });

  test("ferme la carte mobile au lieu de quitter le site", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("mobile-"), "Carte plein écran des mobiles");
    await mockCatalogue(page);
    await page.goto("/sales");

    await expect(async () => {
      await page.getByRole("button", { name: "Carte", exact: true }).click();
      await expect(page).toHaveURL(/[?&]map=true/, { timeout: 1000 });
    }).toPass();
    await expect(page.getByRole("button", { name: "Liste" })).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/sales$/);
    await expect(page.getByRole("button", { name: "Liste" })).toBeHidden();
  });
});

test.describe("liens d'évitement de /sales", () => {
  test("mènent aux résultats, à la pagination et à la carte, dans cet ordre au clavier", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop-chromium", "Parcours au clavier du bureau");
    await mockCatalogue(page);
    await page.goto("/sales");
    await expect(page.getByRole("link", { name: "Page suivante" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Aller à la carte" })).toBeAttached();

    const seen: string[] = [];
    for (let presses = 0; presses < 12 && seen.length < 3; presses += 1) {
      await page.keyboard.press("Tab");
      const text = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");
      if (/^Aller (aux résultats|à la pagination|à la carte)$/.test(text)) seen.push(text);
    }
    expect(seen).toEqual(["Aller aux résultats", "Aller à la pagination", "Aller à la carte"]);

    await page.keyboard.press("Enter");
    await expect(page.getByRole("region", { name: "Carte des ventes" })).toBeFocused();
  });
});
