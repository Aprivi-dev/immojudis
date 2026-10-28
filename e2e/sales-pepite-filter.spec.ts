import { expect, test, type Page } from "@playwright/test";
import { mapPreviewRows, type PreviewSearchRow } from "@/lib/search/preview-search";

/**
 * Filtre « Pépites seulement » de /sales, ouvert aux visiteurs : la liste publique des pépites
 * (`/api/catalogue/pepites`) fait apparaître la bascule et les pastilles ; l'adresse porte `pepite=true`
 * et la recherche d'aperçu reçoit le filtre ; une recherche sans pépite l'explique.
 */

const PEPITE_SALE = "77000000-0000-4000-8000-0000000000b1";
const OTHER_SALE = "77000000-0000-4000-8000-0000000000b2";

function previewRow(id: string, city: string, total: number): PreviewSearchRow {
  return {
    id,
    starting_price_eur: 60_000,
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    city,
    department: "69",
    property_type: "apartment",
    sale_date: "2099-12-12T09:00:00.000Z",
    app_surface_m2: 50,
    app_surface_kind: "habitable",
    rooms_count: 3,
    bedrooms_count: 2,
    bathrooms_count: 1,
    latitude: 45.76,
    longitude: 4.83,
    thumbnail_url: null,
    total_count: total,
  } as unknown as PreviewSearchRow;
}

type Options = {
  /** Réponse de la liste publique des pépites. */
  ids?: { status: number; json: unknown };
  /** Ventes que la recherche rend quand le filtre est demandé. */
  pepiteRows?: PreviewSearchRow[];
};

/** Retourne la liste des adresses `pepite` reçues par la recherche d'aperçu. */
async function mockCatalogue(page: Page, options: Options = {}) {
  const asked: Array<string | null> = [];
  const everyone = [previewRow(PEPITE_SALE, "Lyon", 2), previewRow(OTHER_SALE, "Villeurbanne", 2)];
  await page.route("**/api/catalogue/pepites*", (route) =>
    route.fulfill({
      headers: { "cache-control": "no-store" },
      ...(options.ids ?? { status: 200, json: { ids: [PEPITE_SALE], exposedIds: [] } }),
    }),
  );
  await page.route("**/api/catalogue/preview*", async (route) => {
    const filter = new URL(route.request().url()).searchParams.get("pepite");
    asked.push(filter);
    const rows = filter === "true" ? (options.pepiteRows ?? [everyone[0]]) : everyone;
    await route.fulfill({
      status: 200,
      json: {
        items: mapPreviewRows(rows),
        count: Number(rows[0]?.total_count ?? 0) && rows.length,
        mirrors: [],
      },
    });
  });
  await page.route("https://ci.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
  return asked;
}

const isMobile = (name: string) => name.startsWith("mobile");

test.describe("bascule « Pépites seulement »", () => {
  test("proposée à un visiteur quand il y a des pépites, elle filtre et s'inscrit dans l'adresse", async ({
    page,
  }, testInfo) => {
    const asked = await mockCatalogue(page);
    await page.goto("/sales?city=Lyon");
    await expect(page.getByTestId("pepite-badge").first()).toBeVisible();

    if (isMobile(testInfo.project.name)) {
      const chip = page.getByRole("group", { name: "Filtres rapides" }).getByRole("button", {
        name: "Pépites seulement",
      });
      await expect(chip).toHaveAttribute("aria-pressed", "false");
      await expect(async () => {
        await chip.click();
        await expect(page).toHaveURL(/pepite=true/, { timeout: 1500 });
      }).toPass();
      await expect(chip).toHaveAttribute("aria-pressed", "true");
    } else {
      await page.getByRole("button", { name: /Tous les filtres/ }).click();
      const toggle = page.getByRole("checkbox", { name: /Pépites seulement/ });
      await expect(toggle).not.toBeChecked();
      await toggle.check();
      await expect.poll(() => page.url()).toMatch(/pepite=true/);
    }

    // La recherche a reçu le filtre, et seule la pépite reste à l'écran.
    await expect.poll(() => asked.includes("true")).toBe(true);
    await expect(page.getByText("Villeurbanne")).toHaveCount(0);
    await expect(page.getByText("Lyon").first()).toBeVisible();
  });

  test("sans pépite, la page l'explique au lieu de rester vide", async ({ page }) => {
    await mockCatalogue(page, { pepiteRows: [] });
    await page.goto("/sales?pepite=true");
    await expect(page.getByText("Aucune pépite avec ces critères pour le moment.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Me prévenir dès qu’une pépite apparaît" }),
    ).toBeVisible();
  });

  test("la bascule n'est pas proposée tant qu'aucune pépite n'est publique", async ({
    page,
  }, testInfo) => {
    await mockCatalogue(page, { ids: { status: 200, json: { ids: [], exposedIds: [] } } });
    await page.goto("/sales?city=Lyon");
    await expect(page.getByText("Lyon").first()).toBeVisible();
    await expect(page.getByTestId("pepite-badge")).toHaveCount(0);
    if (isMobile(testInfo.project.name)) {
      await expect(page.getByRole("button", { name: "Pépites seulement" })).toHaveCount(0);
    } else {
      await page.getByRole("button", { name: /Tous les filtres/ }).click();
      await expect(page.getByRole("checkbox", { name: /Pépites seulement/ })).toHaveCount(0);
    }
  });

  test("une panne de la liste publique n'affiche ni pastille ni faux « aucune pépite »", async ({
    page,
  }) => {
    await mockCatalogue(page, {
      ids: { status: 503, json: { ok: false, error: "Indisponible." } },
    });
    await page.goto("/sales?city=Lyon");
    await expect(page.getByText("Lyon").first()).toBeVisible();
    await expect(page.getByTestId("pepite-badge")).toHaveCount(0);
    await expect(page.getByText("Aucune pépite avec ces critères")).toHaveCount(0);
  });
});
