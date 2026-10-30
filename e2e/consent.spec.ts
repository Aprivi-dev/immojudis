import { expect, test, type BrowserContext, type Page } from "@playwright/test";

/**
 * Parcours du « premier visiteur » : personne n'a encore répondu au bandeau (le `storageState` par
 * défaut de `playwright.config.ts` répond « Refuser » d'avance, ce qui rend le bandeau invisible aux
 * autres specs). Google Tag Manager est intercepté : rien ne sort du poste, et chaque requête est
 * comptée pour vérifier qu'aucune ne part avant l'accord.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const CONSENT_KEY = "immojudis:analytics-consent";
const GTM_URL = /googletagmanager\.com\/gtm\.js\?id=GTM-M2MWWPJQ/;

type Tracker = { urls: string[] };

async function trackGoogle(page: Page): Promise<Tracker> {
  const tracker: Tracker = { urls: [] };
  page.on("request", (request) => {
    if (/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/.test(request.url())) {
      tracker.urls.push(request.url());
    }
  });
  await page.route(/googletagmanager\.com/, (route) =>
    route.fulfill({ body: "window.__gtagScriptLoaded = true;", contentType: "text/javascript" }),
  );
  return tracker;
}

const banner = (page: Page) => page.getByTestId("cookie-consent-banner");
const storedChoice = (page: Page) =>
  page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as { choice: string; version?: number }) : null;
  }, CONSENT_KEY);

test("premier visiteur : le bandeau s'affiche et aucune requête Google ne part avant le choix", async ({
  page,
}) => {
  const google = await trackGoogle(page);
  await page.goto("/");

  await expect(banner(page)).toBeVisible({ timeout: 15_000 });
  // Laisse au navigateur le temps d'être inactif et à la balise de partir si elle le devait.
  await page.waitForTimeout(2_500);
  expect(google.urls).toEqual([]);
  expect(await storedChoice(page)).toBeNull();
  expect(await page.context().cookies()).toEqual([]);
});

test("Refuser : aucune requête Google, le choix est mémorisé et le bandeau ne revient pas", async ({
  page,
}) => {
  const google = await trackGoogle(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Refuser" }).click({ timeout: 15_000 });

  await expect(banner(page)).toHaveCount(0);
  await page.waitForTimeout(1_500);
  expect(google.urls).toEqual([]);
  expect(await storedChoice(page)).toMatchObject({ choice: "denied", version: 1 });

  await page.reload();
  await page.waitForTimeout(2_500);
  await expect(banner(page)).toHaveCount(0);
  expect(google.urls).toEqual([]);
});

test("Accepter : le conteneur GTM est chargé, puis plus de bandeau au rechargement", async ({
  page,
}) => {
  const google = await trackGoogle(page);
  await page.goto("/");
  const gtmRequest = page.waitForRequest(GTM_URL, { timeout: 15_000 });
  await page.getByRole("button", { name: "Accepter" }).click({ timeout: 15_000 });
  await gtmRequest;

  await expect(banner(page)).toHaveCount(0);
  expect(await storedChoice(page)).toMatchObject({ choice: "granted", version: 1 });
  // La page vue part dans dataLayer, avec l'adresse nettoyée.
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          ((window as unknown as { dataLayer?: unknown[] }).dataLayer ?? []).some((entry) => {
            const call = Array.from(entry as ArrayLike<unknown>);
            return call[0] === "event" && call[1] === "page_view";
          }),
        ),
      { timeout: 10_000 },
    )
    .toBe(true);

  const reloadedGtm = page.waitForRequest(GTM_URL, { timeout: 15_000 });
  await page.reload();
  await reloadedGtm;
  await page.waitForTimeout(1_500);
  await expect(banner(page)).toHaveCount(0);
  expect(google.urls.length).toBeGreaterThanOrEqual(2);
});

test("le focus revient au contenu principal après le choix, pas sur body", async ({ page }) => {
  await trackGoogle(page);
  await page.goto("/");
  const refuse = page.getByRole("button", { name: "Refuser" });
  await refuse.focus({ timeout: 15_000 });
  await page.keyboard.press("Enter");

  await expect(banner(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.tagName)).toBe("MAIN");
});

async function acceptThenOpenPrivacy(page: Page, context: BrowserContext) {
  await page.goto("/");
  const gtmRequest = page.waitForRequest(GTM_URL, { timeout: 15_000 });
  await page.getByRole("button", { name: "Accepter" }).click({ timeout: 15_000 });
  await gtmRequest;
  // Le conteneur intercepté ne dépose rien : on simule le cookie qu'aurait posé la vraie balise.
  await context.addCookies([
    { name: "_ga", value: "GA1.1.123.456", url: new URL(page.url()).origin },
  ]);
  await page.goto("/privacy#cookies");
}

test("retrait de l'accord par l'interrupteur de /privacy : envois coupés, cookies effacés", async ({
  page,
  context,
}) => {
  const google = await trackGoogle(page);
  await acceptThenOpenPrivacy(page, context);

  const accessSwitch = page.getByRole("switch", { name: /cookies de Google Analytics/ });
  await expect(accessSwitch).toBeChecked({ timeout: 15_000 });
  await accessSwitch.uncheck();

  await expect(accessSwitch).not.toBeChecked();
  expect(await storedChoice(page)).toMatchObject({ choice: "denied" });
  await expect
    .poll(async () => (await context.cookies()).some((cookie) => cookie.name.startsWith("_ga")), {
      timeout: 10_000,
    })
    .toBe(false);

  const before = google.urls.length;
  await page.reload();
  await page.waitForTimeout(2_500);
  expect(google.urls.length).toBe(before);
  await expect(banner(page)).toHaveCount(0);
});

for (const path of ["/login", "/mes-droits", "/contribuer/22222222-2222-4222-8222-222222222222"]) {
  test(`pages sensibles (${path.slice(0, 12)}) : ni bandeau ni balise, même avec un accord donné`, async ({
    page,
  }) => {
    const google = await trackGoogle(page);

    // Sans choix : pas de bandeau.
    await page.goto(path).catch(() => undefined);
    await page.waitForTimeout(2_500);
    await expect(banner(page)).toHaveCount(0);

    // Avec un accord déjà donné ailleurs : pas de balise.
    await page.evaluate((key) => {
      window.localStorage.setItem(
        key,
        JSON.stringify({ choice: "granted", at: new Date().toISOString(), version: 1 }),
      );
    }, CONSENT_KEY);
    await page.reload().catch(() => undefined);
    await page.waitForTimeout(2_500);
    expect(google.urls).toEqual([]);
  });
}

test("écran peu haut (320 × 256) : le bandeau reste dans le flux au lieu de recouvrir la page", async ({
  page,
}) => {
  await trackGoogle(page);
  await page.setViewportSize({ width: 320, height: 256 });
  await page.goto("/");
  await expect(banner(page)).toBeVisible({ timeout: 15_000 });

  expect(await banner(page).evaluate((element) => getComputedStyle(element).position)).toBe(
    "static",
  );
});

test("écran ordinaire : le bandeau est fixé en bas et sa hauteur est réservée", async ({
  page,
}) => {
  await trackGoogle(page);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto("/");
  await expect(banner(page)).toBeVisible({ timeout: 15_000 });

  expect(await banner(page).evaluate((element) => getComputedStyle(element).position)).toBe(
    "fixed",
  );
  const reserved = await page.evaluate(() => ({
    scrollPadding: document.documentElement.style.scrollPaddingBottom,
    height: document.documentElement.style.getPropertyValue("--cookie-banner-height"),
  }));
  expect(reserved.scrollPadding).toMatch(/^\d+px$/);
  expect(reserved.height).toBe(reserved.scrollPadding);
});
