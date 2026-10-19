import { expect, test, type Page } from "@playwright/test";

/**
 * « 3 déblocages par mois » sur la fiche d'une vente, du point de vue d'un compte Découverte
 * connecté. Le serveur Next répond aux appels Supabase côté serveur grâce au préchargement
 * `e2e/support/server-fetch-mock.cjs` (voir `scripts/start-e2e-server.mjs`) ; le navigateur est
 * intercepté ici par `page.route`.
 */

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const userId = "76000000-0000-4000-8000-0000000000aa";
const email = "decouverte.e2e@example.test";
const user = {
  id: userId,
  aud: "authenticated",
  role: "authenticated",
  email,
  email_confirmed_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: { account_type: "b2c" },
};
const session = {
  access_token: fakeJwt({ sub: userId, email, role: "authenticated" }),
  refresh_token: "refresh-e2e",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user,
};
// Une vente au tribunal, toujours à venir quelle que soit la date d'exécution.
const sale = {
  id: SALE_ID,
  title: "Appartement 60 m² à Lyon",
  city: "Lyon",
  department: "69",
  postal_code: "69003",
  address: "1 rue du Test",
  tribunal: "Tribunal judiciaire de Lyon",
  tribunal_code: "TJ-LYON",
  tribunal_name: "Tribunal judiciaire de Lyon",
  property_type: "apartment",
  starting_price_eur: 90000,
  sale_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  latitude: 45.76,
  longitude: 4.85,
  occupancy_status: "vacant",
  app_surface_m2: 60,
  habitable_surface_m2: 60,
  sale_venue_type: "tribunal",
  sale_legal_framework: "saisie_immobiliere",
  sale_verification_status: "verified",
  status: "upcoming",
  documents_rich: [],
  documents: [],
  risks: [],
  score_factors: [],
  quality_flags: [],
  media: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Le mois d'octobre 2026 : le compteur est remis à zéro le 1er novembre.
const period = { periodStart: "2026-09-30T22:00:00.000Z", resetsAt: "2026-10-31T23:00:00.000Z" };
type Status = {
  saleId: string;
  unlocked: boolean;
  unlockable: boolean;
  analysisAccess: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
  periodStart: string;
  resetsAt: string;
};
const status = (used: number, overrides: Partial<Status> = {}): Status => ({
  saleId: SALE_ID,
  unlocked: false,
  unlockable: true,
  analysisAccess: false,
  limit: 3,
  used,
  remaining: Math.max(0, 3 - used),
  ...period,
  ...overrides,
});

type Reply = { status: number; json: unknown };

async function setup(
  page: Page,
  options: {
    initial: Status | "error";
    /** Réponse au n-ième POST (1 = le premier). Par défaut : le déblocage réussit. */
    post?: (call: number) => Reply;
    /** La relecture de la vente débloquée (`v_auction_sales_unlocked`), n-ième appel. */
    unlockedRead?: (call: number) => { delayMs?: number; fail?: boolean };
    plan?: "decouverte" | "analyse";
    offerConfigured?: boolean;
  },
) {
  const counters = { post: 0, get: 0, unlockedView: 0 };
  let unlocked = false;
  await page.route("https://ci.supabase.co/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/user") return route.fulfill({ json: { user } });
    if (url.pathname === "/auth/v1/token") return route.fulfill({ json: session });
    if (url.pathname === "/rest/v1/user_profiles") {
      return route.fulfill({
        headers: { "content-range": "0-0/1" },
        json: [
          {
            user_id: userId,
            email,
            account_type: "b2c",
            account_tier: "free",
            user_role: "user",
            professional_status: "not_applicable",
          },
        ],
      });
    }
    if (url.pathname.includes("v_auction_sales_unlocked")) {
      counters.unlockedView += 1;
      const read = options.unlockedRead?.(counters.unlockedView) ?? {};
      if (read.delayMs) await new Promise((resolve) => setTimeout(resolve, read.delayMs));
      if (read.fail) return route.fulfill({ status: 500, json: { message: "boom" } });
      return route.fulfill({ headers: { "content-range": "0-0/1" }, json: unlocked ? [sale] : [] });
    }
    if (
      url.pathname.includes("v_auction_sales_discovery") ||
      url.pathname.includes("v_auction_sales_app")
    ) {
      return route.fulfill({ headers: { "content-range": "0-0/1" }, json: [sale] });
    }
    return route.fulfill({ json: [] });
  });
  await page.addInitScript((stored) => {
    localStorage.setItem("encheres-immo-auth", JSON.stringify(stored));
  }, session);

  const plan = options.plan ?? "decouverte";
  await page.route(/\/api\/feature-entitlements(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        plan: {
          plan,
          hasAnalysisAccess: plan === "analyse",
          currentPeriodEnd: null,
          limits: {},
          features: {},
        },
        usage: {},
      },
    }),
  );
  await page.route("**/api/billing/offer", (route) =>
    route.fulfill({
      json: {
        configured: options.offerConfigured ?? true,
        trialDays: 7,
        trialAvailable: true,
        label: "59 € / mois",
      },
    }),
  );
  await page.route("**/api/billing/opening-notification", (route) =>
    route.fulfill({ json: { notification: { requested: false, consentedAt: null } } }),
  );
  await page.route("**/api/favorites**", (route) => route.fulfill({ json: { favorites: [] } }));
  await page.route(`**/api/sales/${SALE_ID}/unlock`, async (route) => {
    if (route.request().method() === "POST") {
      counters.post += 1;
      const reply = options.post?.(counters.post) ?? {
        status: 200,
        json: {
          result: { ...status(1, { unlocked: true }), alreadyUnlocked: false, consumed: true },
        },
      };
      if (reply.status === 200) unlocked = true;
      // Laisse le temps d'un deuxième clic sur le bouton en cours de traitement.
      await new Promise((resolve) => setTimeout(resolve, 400));
      return route.fulfill({ status: reply.status, json: reply.json });
    }
    counters.get += 1;
    if (options.initial === "error") {
      return route.fulfill({ status: 500, json: { error: "Déblocage indisponible." } });
    }
    return route.fulfill({
      json: { status: unlocked ? status(1, { unlocked: true }) : options.initial },
    });
  });
  for (const path of ["document-reading", "passages", "auction-scenarios"]) {
    await page.route(`**/api/sales/${SALE_ID}/${path}`, (route) =>
      route.fulfill({ status: 403, json: { error: "Accès réservé." } }),
    );
  }
  await page.route("**/api/market-estimate", (route) =>
    route.fulfill({ status: 503, json: { ok: false, estimate: null } }),
  );
  await page.route("**/api/sales/ai-review**", (route) =>
    route.fulfill({ json: { projections: [] } }),
  );
  return counters;
}

const unlockButton = (page: Page) => page.getByRole("button", { name: "Débloquer cette vente" });
const confirmButton = (page: Page) => page.getByRole("button", { name: "Confirmer le déblocage" });

async function requestUnlock(page: Page) {
  await unlockButton(page).click();
  await confirmButton(page).click();
}

test("visiteur : la fiche publique propose de créer un compte, avec le motif de la fiche", async ({
  page,
}) => {
  await page.goto(`/sales/${SALE_ID}`);

  const create = page.getByRole("link", { name: "Créer mon compte gratuit" }).first();
  await expect(create).toBeVisible();
  const href = new URL((await create.getAttribute("href")) ?? "", "https://example.test");
  expect(href.pathname).toBe("/login");
  expect(href.searchParams.get("mode")).toBe("investor");
  expect(href.searchParams.get("reason")).toBe("fiche");
  expect(href.searchParams.get("redirect")).toContain(`/sales/${SALE_ID}`);

  await create.click();
  await expect(page.getByTestId("login-reason")).toContainText(
    "Créez votre compte gratuit pour voir l'adresse, les photos et la fourchette de valeur",
  );
});

test("compte Découverte : « Débloquer cette vente » d'un aperçu mène à la carte de déblocage", async ({
  page,
}) => {
  await setup(page, { initial: status(0) });
  await page.goto(`/sales/${SALE_ID}`);
  await expect(page.getByRole("heading", { name: "Débloquer cette vente" })).toBeVisible();

  const link = page
    .getByRole("link", { name: "Débloquer cette vente (il vous reste 3 sur 3)" })
    .first();
  await expect(link).toHaveAttribute("href", "#debloquer");
  await expect(
    page.getByRole("link", { name: /Découvrir l.(offre Analyse|analyse)/ }).first(),
  ).toBeVisible();

  // La page a défilé jusqu'aux onglets : le lien ramène quand même à la carte, sans changer d'onglet.
  await page.locator("#annonce-sections").scrollIntoViewIfNeeded();
  await expect(page.locator("#debloquer")).not.toBeInViewport();
  await link.evaluate((element) => (element as HTMLElement).click());

  await expect(page.locator("#debloquer")).toBeInViewport();
  await expect(unlockButton(page)).toBeFocused();
  expect(new URL(page.url()).hash).toBe("");
});

test("un double clic sur « Confirmer le déblocage » ne consomme qu'un déblocage", async ({
  page,
}) => {
  const counters = await setup(page, { initial: status(0) });
  await page.goto(`/sales/${SALE_ID}`);
  await expect(page.getByText("Il vous reste 3 déblocages sur 3 ce mois-ci.")).toBeVisible();

  await unlockButton(page).click();
  await expect(confirmButton(page)).toBeFocused();
  await confirmButton(page).dblclick();

  await expect(page.getByRole("heading", { name: "Cette vente est débloquée" })).toBeVisible();
  await expect(page.getByText("Il vous reste 2 déblocages sur 3 ce mois-ci.")).toBeVisible();
  expect(counters.post).toBe(1);
});

test("après le déblocage, la fiche reste affichée avec un bandeau pendant la relecture", async ({
  page,
}) => {
  await setup(page, {
    initial: status(0),
    unlockedRead: () => ({ delayMs: 1500 }),
  });
  await page.goto(`/sales/${SALE_ID}`);
  await requestUnlock(page);

  const banner = page
    .getByRole("status")
    .filter({ hasText: "Vente débloquée. Chargement du détail…" });
  await expect(banner).toBeVisible();
  // Pas d'écran blanc ni de squelette plein écran : la fiche est toujours là.
  await expect(page.getByRole("status", { name: "Chargement de la fiche" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Cette vente est débloquée" })).toBeVisible();
  await expect(banner).toBeHidden();
  await expect(page.getByText("Il vous reste 2 déblocages sur 3 ce mois-ci.")).toBeVisible();
});

test("si la relecture échoue après le déblocage : bandeau « conservé », « Réessayer », pas de page d'erreur", async ({
  page,
}) => {
  const counters = await setup(page, {
    initial: status(0),
    // La lecture et sa nouvelle tentative automatique échouent, puis tout rentre dans l'ordre.
    unlockedRead: (call) => ({ fail: call <= 2 }),
  });
  await page.goto(`/sales/${SALE_ID}`);
  await requestUnlock(page);

  const alert = page
    .getByRole("alert")
    .filter({ hasText: "Vente débloquée, mais le détail n’a pas pu être chargé." });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Votre déblocage est conservé.");
  await expect(page.getByText("Vos données n’ont pas été modifiées")).toHaveCount(0);

  await alert.getByRole("button", { name: "Réessayer" }).click();
  await expect(alert).toBeHidden();
  await expect(page.getByRole("heading", { name: "Cette vente est débloquée" })).toBeVisible();
  expect(counters.post).toBe(1);
});

test("quota épuisé au chargement : date de retour, offre ouverte, aucun bouton de déblocage", async ({
  page,
}) => {
  await setup(page, { initial: status(3) });
  await page.goto(`/sales/${SALE_ID}`);

  await expect(
    page.getByRole("heading", { name: "Vous avez utilisé vos déblocages" }),
  ).toBeVisible();
  await expect(page.getByText(/Ils reviennent le 1er novembre/)).toBeVisible();
  await expect(
    page.getByText("Vos 3 déblocages d’octobre reviennent le 1er novembre.").first(),
  ).toBeVisible();
  await expect(unlockButton(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Voir l’offre Analyse" }).first()).toHaveAttribute(
    "href",
    "/offres",
  );
  await expect(page.getByRole("link", { name: /Débloquer cette vente/ })).toHaveCount(0);
});

test("quota épuisé et offre fermée : « Me prévenir de l'ouverture » plutôt qu'un lien vers l'offre", async ({
  page,
}) => {
  await setup(page, { initial: status(3), offerConfigured: false });
  await page.goto(`/sales/${SALE_ID}`);

  const card = page.locator("#debloquer");
  await expect(
    card.getByRole("heading", { name: "Vous avez utilisé vos déblocages" }),
  ).toBeVisible();
  await expect(card.getByRole("button", { name: "Me prévenir de l’ouverture" })).toBeVisible();
  await expect(card.getByRole("link", { name: /offre Analyse/ })).toHaveCount(0);
  await expect(card).toContainText("L’offre Analyse n’est pas encore ouverte à la souscription.");
});

test("quota dépensé ailleurs : le 409 bascule sur l'écran épuisé", async ({ page }) => {
  await setup(page, {
    initial: status(2),
    post: () => ({
      status: 409,
      json: { error: "x", code: "unlock_quota_reached", status: status(3) },
    }),
  });
  await page.goto(`/sales/${SALE_ID}`);
  await requestUnlock(page);

  await expect(
    page.getByRole("heading", { name: "Vous avez utilisé vos déblocages" }),
  ).toBeVisible();
  await expect(unlockButton(page)).toHaveCount(0);
});

test("état des déblocages indisponible : bandeau et fiche gratuite, sans bouton", async ({
  page,
}) => {
  await setup(page, { initial: "error" });
  await page.goto(`/sales/${SALE_ID}`);

  await expect(page.getByText("État de vos déblocages indisponible")).toBeVisible({
    timeout: 15_000,
  });
  await expect(unlockButton(page)).toHaveCount(0);
});

test("vente non débloquable : un texte adapté à la place du bouton", async ({ page }) => {
  await setup(page, { initial: status(0, { unlockable: false }) });
  await page.goto(`/sales/${SALE_ID}`);

  await expect(
    page.getByText("Cette vente ne peut pas être débloquée pour le moment."),
  ).toBeVisible();
  await expect(unlockButton(page)).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Débloquer cette vente/ })).toHaveCount(0);
});

for (const [name, reply, message] of [
  [
    "session expirée (401)",
    { status: 401, json: { error: "Unauthorized: invalid token" } },
    "Votre session a expiré. Reconnectez-vous.",
  ],
  [
    "vente retirée entre-temps (404)",
    { status: 404, json: { error: "Vente introuvable ou plus en ligne." } },
    "Vente introuvable ou plus en ligne.",
  ],
  [
    "limite de débit (429)",
    { status: 429, json: { error: "Too many requests" } },
    "Trop de demandes. Patientez un instant avant de réessayer.",
  ],
  [
    "erreur serveur (500)",
    { status: 500, json: { error: "Déblocage indisponible." } },
    "Déblocage indisponible.",
  ],
  [
    "déblocage pas encore disponible (503)",
    { status: 503, json: { error: "Le déblocage d’une vente n’est pas encore disponible." } },
    "Le déblocage d’une vente n’est pas encore disponible.",
  ],
] as const satisfies readonly (readonly [string, Reply, string])[]) {
  test(`erreur au déblocage, ${name} : message lisible et bouton réutilisable`, async ({
    page,
  }) => {
    const counters = await setup(page, { initial: status(0), post: () => reply });
    await page.goto(`/sales/${SALE_ID}`);
    await requestUnlock(page);

    await expect(page.getByRole("alert").filter({ hasText: message })).toBeVisible();
    // Rien n'est consommé ni affiché comme débloqué : le compte peut réessayer.
    await expect(page.getByRole("heading", { name: "Cette vente est débloquée" })).toHaveCount(0);
    await expect(unlockButton(page)).toBeVisible();
    expect(counters.post).toBe(1);
  });
}

test("compte Analyse : aucun panneau ni lien de déblocage", async ({ page }) => {
  const counters = await setup(page, {
    plan: "analyse",
    initial: status(0, { analysisAccess: true, limit: null, remaining: null }),
  });
  await page.goto(`/sales/${SALE_ID}`);

  // La fiche s'affiche une fois les droits lus : c'est à ce moment qu'un compte Découverte
  // demanderait l'état de ses déblocages.
  await expect(page.getByRole("heading", { level: 1, name: sale.title })).toBeVisible();
  await page.waitForTimeout(500);
  // L'état des déblocages n'est même pas demandé à un compte qui a déjà toutes les ventes.
  expect(counters.get).toBe(0);
  await expect(page.getByRole("heading", { name: "Débloquer cette vente" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Débloquer cette vente/ })).toHaveCount(0);
  await expect(page.locator("#debloquer")).toHaveCount(0);
});

function fakeJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}
