import { expect, test, type Page } from "@playwright/test";
import { pepiteCriteriaPayload, pepiteCriteriaViews } from "@/lib/sale-pepite-view";

/**
 * Fiche publique d'une vente (visiteur sans compte) : cinq ventes aux profils variés, servies par le
 * préchargement `e2e/support/server-fetch-mock.cjs` côté serveur, et le repère « Pépite » dont la
 * lecture des critères répond d'abord 200 puis 503.
 */

const ids = {
  tribunal: "11111111-1111-4111-8111-111111111111",
  pepite: "77000000-0000-4000-8000-000000000002",
  notary: "77000000-0000-4000-8000-000000000003",
  past: "77000000-0000-4000-8000-000000000004",
  state: "77000000-0000-4000-8000-000000000005",
};

const criteria = pepiteCriteriaPayload(
  pepiteCriteriaViews(
    ["pass:regime_open", "pass:sale_upcoming", "pass:test_c_cost"],
    [],
    "notary_auction",
  ),
);

/** Ce que le navigateur interroge : rien ne part vers la base, l'essai est ouvert. */
async function mockBrowser(page: Page, pepite: "ok" | "unavailable" = "ok") {
  await page.route("https://ci.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
  await page.route("**/api/launch-offer*", (route) => route.fulfill({ json: { active: true } }));
  await page.route("**/api/sales/*/pepite*", (route) =>
    pepite === "ok"
      ? route.fulfill({ json: criteria })
      : route.fulfill({ status: 503, json: { ok: false, error: "Indisponible." } }),
  );
}

async function openSale(page: Page, id: string) {
  const response = await page.goto(`/sales/${id}`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
}

test.describe("ventes aux profils variés", () => {
  test("une vente notariale sans ville, sans prix et sans date reste lisible", async ({ page }) => {
    await mockBrowser(page);
    await openSale(page, ids.notary);
    const body = page.locator("main");
    // Ni mise à prix ni date inventées : « À confirmer ».
    await expect(body).toContainText(/Mise à prix\s*À confirmer/);
    // Pas de date : pas de bouton d'agenda, la fiche ne dit pas qu'elle est passée.
    await expect(page.getByTestId("past-sale-date")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /agenda/i })).toHaveCount(0);
    await expect(page.getByTestId("public-signup")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("une vente dont la date est passée le dit, sans proposer d'agenda", async ({ page }) => {
    await mockBrowser(page);
    await openSale(page, ids.past);
    await expect(page.getByTestId("past-sale-date")).toBeVisible();
    await expect(page.getByRole("button", { name: /agenda/i })).toHaveCount(0);
    await expect(page.getByRole("link", { name: /agenda/i })).toHaveCount(0);
    await expect(page.getByTestId("public-signup")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("une vente domaniale sans prix n'invente pas de montant", async ({ page }) => {
    await mockBrowser(page);
    await openSale(page, ids.state);
    await expect(page.locator("main")).toContainText(/Prix non (communiqué|publié)/);
    await expect(page.getByTestId("public-signup")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("une vente au tribunal ordinaire n'a ni pastille ni bloc Pépite", async ({ page }) => {
    await mockBrowser(page);
    await openSale(page, ids.tribunal);
    await expect(page.getByTestId("pepite-badge")).toHaveCount(0);
    await expect(page.locator("#pepite")).toHaveCount(0);
  });
});

test.describe("repère « Pépite » de la fiche publique", () => {
  test("avec les critères : pastille, « Pourquoi ? » vers le bloc, et bloc verrouillé pour un visiteur", async ({
    page,
  }) => {
    await mockBrowser(page, "ok");
    await openSale(page, ids.pepite);
    await expect(page.getByTestId("pepite-badge").first()).toBeVisible();
    const block = page.locator("#pepite");
    await expect(block).toBeVisible();
    const why = page.getByRole("link", { name: "Pourquoi ?" });
    await expect(why).toHaveAttribute("href", "#pepite");
    // Un visiteur lit ce que le compte gratuit lui ouvre, jamais un montant.
    await expect(
      block.getByRole("link", { name: "Créez un compte gratuit pour voir le détail du calcul" }),
    ).toBeVisible();
    await expect(block).not.toContainText("€");
  });

  test("si les critères ne se chargent pas (503) : ni lien mort, ni bloc, une ligne d'erreur", async ({
    page,
  }) => {
    await mockBrowser(page, "unavailable");
    await openSale(page, ids.pepite);
    await expect(page.getByTestId("pepite-badge").first()).toBeVisible();
    await expect(page.getByTestId("pepite-block-error")).toBeVisible();
    // « Pourquoi ? » n'existe plus : la pastille renvoie à la page de méthode.
    await expect(page.getByRole("link", { name: "Pourquoi ?" })).toHaveCount(0);
    await expect(page.locator("a[href='#pepite']")).toHaveCount(0);
    await expect(
      page
        .locator("main")
        .getByRole("link", { name: /Comment repérons-nous/ })
        .first(),
    ).toHaveAttribute("href", "/methode-pepites");
    await expectNoHorizontalOverflow(page);
  });

  test("la lecture lente laisse un emplacement, puis le bloc arrive sans lien mort entre-temps", async ({
    page,
  }) => {
    await page.route("https://ci.supabase.co/**", (route) =>
      route.fulfill({ status: 200, json: [] }),
    );
    await page.route("**/api/launch-offer*", (route) => route.fulfill({ json: { active: true } }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/sales/*/pepite*", async (route) => {
      await gate;
      await route.fulfill({ json: criteria });
    });
    await openSale(page, ids.pepite);
    await expect(page.getByTestId("pepite-block-loading")).toBeVisible();
    await expect(page.getByRole("link", { name: "Pourquoi ?" })).toHaveCount(0);
    release();
    await expect(page.locator("#pepite")).toBeVisible();
    await expect(page.getByRole("link", { name: "Pourquoi ?" })).toHaveAttribute("href", "#pepite");
  });

  test("« Pourquoi ? » se suit au clavier jusqu'au bloc", async ({ page }) => {
    await mockBrowser(page, "ok");
    await openSale(page, ids.pepite);
    await page.getByRole("link", { name: "Pourquoi ?" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#pepite$/);
  });
});
