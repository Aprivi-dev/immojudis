import { expect, test, type Page, type Route } from "@playwright/test";
import { mapPreviewRows, type PreviewSearchRow } from "@/lib/search/preview-search";
import { parsePreviewSearchRequest } from "@/lib/search/preview-search-request";

const userId = "76000000-0000-4000-8000-000000000002";
const email = "favoris.e2e@example.test";
const user = {
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email,
  email_confirmed_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { account_type: "b2c", full_name: "Favoris E2E" },
};
const SALE_A = "77000000-0000-4000-8000-0000000000a1";
const SALE_B = "77000000-0000-4000-8000-0000000000a2";

function previewRow(id: string, city: string, price: number, surface: number) {
  return {
    id,
    starting_price_eur: price,
    sale_venue_type: "tribunal",
    sale_verification_status: "verified",
    city,
    department: "69",
    property_type: "apartment",
    sale_date: "2026-12-12T09:00:00.000Z",
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

function appRow(id: string, city: string, price: number, surface: number) {
  return {
    ...previewRow(id, city, price, surface),
    title: `Appartement ${city}`,
    status: "upcoming",
    occupancy_status: "libre",
    documents_rich: [],
    documents: [],
    risks: [],
    score_factors: [],
    quality_flags: [],
    media: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

const PREVIEW_ROWS = [
  previewRow(SALE_A, "Lyon", 60_000, 40),
  previewRow(SALE_B, "Villeurbanne", 96_000, 60),
];
const APP_ROWS = [appRow(SALE_A, "Lyon", 60_000, 40), appRow(SALE_B, "Villeurbanne", 96_000, 60)];

/** Catalogue public : deux ventes pour un visiteur, aucune pour une recherche trop étroite. */
async function mockPublicCatalogue(page: Page, rows: unknown[] = PREVIEW_ROWS) {
  // Le navigateur d'un visiteur interroge notre route `/api/catalogue/preview` (liste, total et
  // copies de photos en une réponse), pas Supabase.
  await page.route("**/api/catalogue/preview*", async (route) => {
    // Comme la vraie route : une adresse qui n'est pas canonique (paramètre inconnu, entier illisible)
    // est refusée en 400. Le test échoue donc si le navigateur envoie autre chose que ce qu'elle accepte.
    const parsed = parsePreviewSearchRequest(new URL(route.request().url()).searchParams);
    if (!parsed.ok) {
      await route.fulfill({
        status: 400,
        json: { ok: false, error: parsed.message, code: "INVALID_REQUEST" },
      });
      return;
    }
    const previewRows = rows as PreviewSearchRow[];
    await route.fulfill({
      status: 200,
      json: {
        items: mapPreviewRows(previewRows),
        count: Number(previewRows[0]?.total_count ?? 0),
        mirrors: [],
      },
    });
  });
  await page.route("https://ci.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: [] }),
  );
}

test.describe("visiteur sans compte", () => {
  test("le cœur ouvre « Créer un compte » avec le motif et la recherche en retour", async ({
    page,
  }) => {
    await mockPublicCatalogue(page);
    await page.goto("/sales?city=Lyon");

    const heart = page.getByRole("button", { name: "Ajouter aux favoris" }).first();
    await expect(heart).toBeVisible();
    await expect(heart).toHaveAttribute(
      "title",
      "Créer un compte gratuit pour garder cette vente (10 favoris)",
    );
    const box = await heart.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);

    await expect(async () => {
      await heart.click();
      await expect(page).toHaveURL(/\/login\?/, { timeout: 1000 });
    }).toPass();
    await expect(page).toHaveURL(/mode=investor/);
    await expect(page).toHaveURL(/reason=favori/);
    await expect(page).toHaveURL(/redirect=%2Fsales%3Fcity%3DLyon/);
    await expect(page.getByTestId("login-reason")).toContainText(
      "Créez votre compte gratuit pour garder cette vente en favori",
    );
    await expect(page.getByRole("button", { name: "Créer mon compte gratuit" })).toBeVisible();
  });

  test("la cloche ouvre « Créer un compte » avec le motif « alerte »", async ({ page }) => {
    await mockPublicCatalogue(page);
    await page.goto("/sales?city=Lyon");

    await expect(async () => {
      await page.getByRole("button", { name: "Créer une alerte" }).first().click();
      await expect(page).toHaveURL(/mode=investor/, { timeout: 1000 });
    }).toPass();
    await expect(page).toHaveURL(/reason=alerte/);
    await expect(page.getByTestId("login-reason")).toContainText("enregistrer cette alerte");
  });

  test("le comparateur affiche prix au m², occupation et département", async ({
    page,
  }, testInfo) => {
    await mockPublicCatalogue(page);
    await page.goto("/sales?city=Lyon");

    // Le premier clic peut précéder l'hydratation : on le rejoue jusqu'à ce qu'il soit pris.
    for (const index of [0, 1]) {
      const toggle = page.getByRole("button", { name: /^Comparer Appartement/ }).nth(index);
      await expect(async () => {
        await toggle.click();
        await expect(toggle).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
      }).toPass();
    }
    const bar = page.getByRole("region", { name: "Sélection à comparer" });
    await expect(bar).toContainText("2/3 biens sélectionnés");

    // La barre reste collée sous l'en-tête de recherche, quelle que soit la largeur.
    const barTop = await bar.evaluate((node) => getComputedStyle(node).top);
    expect(barTop).not.toBe("0px");

    await bar.getByRole("button", { name: "Comparer (2)" }).click();
    const dialog = page.getByRole("dialog", { name: "Comparer les biens" });
    await expect(dialog).toBeVisible();
    for (const label of ["Département", "Occupation", "Mise à prix / m²"]) {
      await expect(dialog.getByRole("rowheader", { name: label })).toBeVisible();
    }
    await expect(dialog.getByRole("cell", { name: /1\s?500\s€\/m²/ })).toBeVisible();

    const footerToggle = dialog.getByRole("button", { name: /Comparaisons enregistrées/ });
    if (testInfo.project.name.startsWith("mobile-")) {
      await expect(footerToggle).toHaveAttribute("aria-expanded", "false");
      await expect(dialog.getByText(/n’est ni le prix final/)).toBeHidden();
      await footerToggle.click();
      await expect(dialog.getByText(/n’est ni le prix final/)).toBeVisible();
    } else {
      await expect(dialog.getByText(/n’est ni le prix final/)).toBeVisible();
    }
  });
});

test.describe("recherche sans résultat", () => {
  test("propose de retirer chaque critère, d'effacer les filtres ou de voir toute la France", async ({
    page,
  }) => {
    await mockPublicCatalogue(page, []);
    await page.goto("/sales?city=Lyon&maxPrice=100000");

    const empty = page.getByRole("heading", { name: "Aucun dossier trouvé" });
    await expect(empty).toBeVisible();
    const chips = page.getByRole("list", { name: "Critères actifs" });
    await expect(chips.getByRole("button", { name: "Retirer le critère : Lyon" })).toBeVisible();

    await chips.getByRole("button", { name: /Retirer le critère : Mise à prix/ }).click();
    await expect(page).not.toHaveURL(/maxPrice=/);
    await expect(page).toHaveURL(/city=Lyon/);

    await page.getByRole("button", { name: "Voir toute la France" }).click();
    await expect(page).not.toHaveURL(/city=/);
  });

  test("« Effacer les filtres » reste accessible sur mobile", async ({ page }, testInfo) => {
    test.skip(!testInfo.project.name.startsWith("mobile-"), "Contrôle réservé aux profils mobiles");
    await mockPublicCatalogue(page);
    await page.goto("/sales?city=Lyon&maxPrice=100000");
    await expect(page.getByRole("button", { name: "Effacer les filtres" }).first()).toBeVisible();
  });
});

test.describe("compte gratuit connecté", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((storedUser) => {
      window.localStorage.setItem(
        "encheres-immo-auth",
        JSON.stringify({
          access_token: "e2e-access-token",
          refresh_token: "e2e-refresh-token",
          token_type: "bearer",
          expires_in: 3600,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: storedUser,
        }),
      );
    }, user);

    await page.route("https://ci.supabase.co/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/auth/v1/user") {
        await route.fulfill({ status: 200, json: user });
        return;
      }
      if (url.pathname === "/rest/v1/user_profiles") {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "content-range": "0-0/1" },
          json: [
            {
              user_id: userId,
              email,
              full_name: "Favoris E2E",
              account_type: "b2c",
              account_tier: "free",
              user_role: "user",
              professional_role: null,
              organization_name: null,
              professional_status: "not_applicable",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        });
        return;
      }
      if (url.pathname === "/rest/v1/user_alerts" && route.request().method() === "POST") {
        await route.fulfill({ status: 201, body: "" });
        return;
      }
      if (url.pathname.includes("v_auction_sales") || url.pathname.includes("search_auction")) {
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/json", "content-range": "0-1/2" },
          json: APP_ROWS,
        });
        return;
      }
      await route.fulfill({ status: 200, json: [] });
    });
    await page.route(/\/api\/feature-entitlements(?:\?.*)?$/, (route) =>
      route.fulfill({
        status: 200,
        json: {
          plan: {
            plan: "decouverte",
            hasAnalysisAccess: false,
            currentPeriodEnd: null,
            limits: {},
            features: { watchedZones: "locked" },
          },
          usage: {},
        },
      }),
    );
  });

  test("le cœur confirme l'ajout, compte les places et renvoie vers les alertes", async ({
    page,
  }) => {
    let added = false;
    await page.route("https://ci.supabase.co/rest/v1/user_favorites**", (route) =>
      route.fulfill({
        status: 200,
        headers: { "content-type": "application/json" },
        json: added ? [{ sale_id: SALE_A }] : [],
      }),
    );
    await page.route("**/api/favorites", async (route) => {
      if (route.request().method() === "POST") {
        added = true;
        await route.fulfill({
          status: 200,
          json: {
            favorite: { saleId: SALE_A },
            created: true,
            plan: { code: "decouverte", limit: 3 },
          },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json: {
          favorites: [{ saleId: SALE_A }, { saleId: SALE_B }],
          unavailableSaleIds: [],
          summary: {},
          plan: { code: "decouverte", limit: 3 },
        },
      });
    });
    await page.goto("/sales?city=Lyon");

    await page.getByRole("button", { name: "Ajouter aux favoris" }).first().click();
    const toast = page.getByText("Vente ajoutée aux favoris : 2 favoris sur 3.");
    await expect(toast).toBeVisible();
    await expect(page.getByRole("link", { name: /créer une alerte/ })).toHaveAttribute(
      "href",
      "/alertes",
    );
    await expect(page.getByRole("button", { name: "Retirer des favoris" }).first()).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  test("la création d'une alerte propose un email hebdomadaire, jamais pré-coché", async ({
    page,
  }) => {
    const consents: unknown[] = [];
    await page.route("**/api/notification-preferences", async (route) => {
      if (route.request().method() === "PATCH") {
        consents.push(route.request().postDataJSON());
        await route.fulfill({
          status: 200,
          json: { preferences: { alertEmailEnabled: true, consentSource: "alert_creation" } },
        });
        return;
      }
      await route.fulfill({
        status: 200,
        json: { preferences: { alertEmailEnabled: false, consentSource: "settings" } },
      });
    });
    await page.goto("/sales?city=Lyon");

    const checkbox = page.getByRole("checkbox", {
      name: /Recevoir un email récapitulatif chaque semaine/,
    });
    // Le premier clic peut précéder l'hydratation : on le rejoue jusqu'à ce qu'il soit pris.
    await expect(async () => {
      await page.getByRole("button", { name: "Créer une alerte" }).first().click();
      await expect(checkbox).toBeVisible({ timeout: 1000 });
    }).toPass();
    await expect(checkbox).not.toBeChecked();

    // Sans la case : l'alerte est créée, aucun consentement n'est enregistré.
    await page.getByRole("button", { name: "Créer l’alerte" }).click();
    await expect(page.getByText("Recherche enregistrée", { exact: true })).toBeVisible();
    expect(consents).toEqual([]);

    await page.getByRole("button", { name: "Créer une alerte" }).first().click();
    await page
      .getByRole("checkbox", { name: /Recevoir un email récapitulatif chaque semaine/ })
      .check();
    await page.getByRole("button", { name: "Créer l’alerte" }).click();
    await expect(page.getByText(/Email récapitulatif activé/)).toBeVisible();
    expect(consents).toEqual([{ alertEmailEnabled: true, consentSource: "alert_creation" }]);
  });
});

test.describe("session impossible à vérifier", () => {
  const PAGES = ["/favoris", "/alertes", "/compte", "/sales?city=Lyon"] as const;
  const UNAVAILABLE = "Nous n’avons pas pu vérifier votre connexion.";
  const EXPIRED = "Votre session a expiré.";

  /** Session stockée dans le navigateur, comme après une connexion ; durée négative : jeton périmé. */
  async function storeSession(page: Page, expiresInSeconds = 3600) {
    await page.addInitScript(
      ({ storedUser, expiresIn }) => {
        window.localStorage.setItem(
          "encheres-immo-auth",
          JSON.stringify({
            access_token: "e2e-access-token",
            refresh_token: "e2e-refresh-token",
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + expiresIn,
            user: storedUser,
          }),
        );
      },
      { storedUser: user, expiresIn: expiresInSeconds },
    );
  }

  /** Supabase répond `[]` partout ; l'identité (`/auth/v1/user`) est réglée par chaque test. */
  async function mockSupabase(page: Page, identity: (route: Route) => Promise<void>) {
    await mockPublicCatalogue(page);
    await page.route("https://ci.supabase.co/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/auth/v1/user") return identity(route);
      await route.fulfill({ status: 200, json: [] });
    });
    await page.route("**/api/favorites", (route) =>
      route.fulfill({
        status: 200,
        json: { favorites: [], unavailableSaleIds: [], summary: {}, plan: { code: "decouverte" } },
      }),
    );
  }

  for (const path of PAGES) {
    test(`${path} : réseau coupé, bandeau « Réessayer » / « Se reconnecter » sans renvoi vers /login`, async ({
      page,
    }) => {
      await storeSession(page);
      await mockSupabase(page, (route) => route.abort("connectionfailed"));
      await page.goto(path);

      const banner = page.getByTestId("auth-connection-banner");
      await expect(banner).toContainText(UNAVAILABLE);
      await expect(banner.getByRole("button", { name: "Réessayer" })).toBeVisible();
      await expect(banner.getByRole("link", { name: "Se reconnecter" })).toHaveAttribute(
        "href",
        /^\/login\?redirect=/,
      );
      // Les cibles du bandeau font au moins 44 px.
      for (const control of [
        banner.getByRole("button", { name: "Réessayer" }),
        banner.getByRole("link", { name: "Se reconnecter" }),
      ]) {
        expect((await control.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      }
      await expect(page).not.toHaveURL(/\/login/);
    });

    test(`${path} : session refusée par le serveur (401), seule la reconnexion est proposée`, async ({
      page,
    }) => {
      await storeSession(page);
      await mockSupabase(page, (route) =>
        route.fulfill({
          status: 401,
          json: { code: 401, error_code: "bad_jwt", msg: "invalid JWT" },
        }),
      );
      await page.goto(path);

      const banner = page.getByTestId("auth-connection-banner");
      await expect(banner).toContainText(EXPIRED);
      await expect(banner.getByRole("link", { name: "Se reconnecter" })).toBeVisible();
      await expect(banner.getByRole("button", { name: "Réessayer" })).toHaveCount(0);
      await expect(page).not.toHaveURL(/\/login/);
    });
  }

  test("jeton périmé dont le renouvellement est refusé (401 puis refus du refresh) : le compte est bien déconnecté, retour à /login", async ({
    page,
  }) => {
    // Un refresh refusé par le serveur n'est pas une panne : la session est retirée par supabase-js
    // (SIGNED_OUT), la page protégée renvoie vers la connexion comme avant, sans bandeau ni boucle.
    await storeSession(page, -60);
    await mockSupabase(page, (route) => route.fulfill({ status: 200, json: user }));
    await page.route("https://ci.supabase.co/auth/v1/token**", (route) =>
      route.fulfill({
        status: 400,
        json: { error: "invalid_grant", error_description: "Invalid Refresh Token" },
      }),
    );
    await page.goto("/favoris");

    await expect(page).toHaveURL(/\/login\?redirect=%2Ffavoris/);
    await expect(page.getByTestId("auth-connection-banner")).toHaveCount(0);
  });

  test("« Réessayer » revérifie le compte quand le réseau revient", async ({ page }) => {
    let networkUp = false;
    await storeSession(page);
    await mockSupabase(page, (route) =>
      networkUp ? route.fulfill({ status: 200, json: user }) : route.abort("connectionfailed"),
    );
    await page.goto("/favoris");

    const banner = page.getByTestId("auth-connection-banner");
    await expect(banner).toContainText(UNAVAILABLE);
    networkUp = true;
    await banner.getByRole("button", { name: "Réessayer" }).click();
    await expect(page.getByTestId("auth-connection-banner")).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/login/);
  });
});
