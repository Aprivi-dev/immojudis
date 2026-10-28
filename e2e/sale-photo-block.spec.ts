import { expect, test, type Page } from "@playwright/test";

/**
 * Visuel de tête de la fiche (photos, vue aérienne 360°) : sur ordinateur il garde une hauteur
 * bornée (490 à 560 px) au lieu de suivre la colonne de droite, et la carte Mapbox suit son
 * conteneur après un changement d'onglet ou un redimensionnement de la fenêtre.
 *
 * Page d'exemple : elle ne dépend d'aucun compte ni d'aucun appel Supabase. Elle est en
 * démonstration publique : la vue aérienne y reste une image fixe, sans canevas Mapbox ; les
 * contrôles du canevas valent donc quand il existe (fiche d'une vente, build avec un jeton Mapbox).
 */

const MIN_HEIGHT = 490;
const MAX_HEIGHT = 560;

type Box = { w: number; h: number };
type Sizes = {
  root: Box | null;
  container: Box | null;
  canvas: Box | null;
  canvasPixels: Box | null;
  pixelRatio: number;
};

/** Le visuel affiché : la photo principale (ordinateur) ou la vue aérienne, selon l'onglet. */
function mainVisual(page: Page, view: "photos" | "vue") {
  return view === "vue"
    ? page.locator("[data-orbit-status]:visible")
    : page.getByRole("button", { name: "Ouvrir la galerie photos" });
}

/**
 * Hauteur du visuel une fois la fiche affichée (la mise en page n'existe pas avant l'hydratation),
 * arrondie au pixel : Firefox rend 500 px en 499,99997.
 */
async function heightOf(page: Page, view: "photos" | "vue") {
  const visual = mainVisual(page, view);
  await expect.poll(async () => (await visual.boundingBox())?.height ?? 0).toBeGreaterThan(0);
  return Math.round((await visual.boundingBox())?.height ?? 0);
}

/** Tailles du cadre de la vue aérienne, de son conteneur Mapbox et de son canevas (s'il existe). */
async function orbitSizes(page: Page): Promise<Sizes> {
  return page.evaluate(() => {
    const box = (element: Element | null | undefined) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { w: rect.width, h: rect.height };
    };
    const container = document.querySelector('[data-testid="aerial-orbit-map"]');
    const canvas = container?.querySelector("canvas");
    return {
      root: box(container?.closest("[data-orbit-status]")),
      container: box(container),
      canvas: box(canvas),
      canvasPixels: canvas ? { w: canvas.width, h: canvas.height } : null,
      pixelRatio: window.devicePixelRatio,
    };
  });
}

/** Le conteneur est le cadre ; le canevas, s'il existe, est le conteneur (à 1 px d'arrondi près). */
function expectOrbitFollowsFrame(sizes: Sizes) {
  expect(sizes.root).not.toBeNull();
  expect(sizes.container).not.toBeNull();
  expect(Math.abs(sizes.container!.w - sizes.root!.w)).toBeLessThan(1);
  expect(Math.abs(sizes.container!.h - sizes.root!.h)).toBeLessThan(1);
  expect(sizes.container!.h).toBeGreaterThan(0);
  if (!sizes.canvas) return;
  expect(Math.abs(sizes.canvas.w - sizes.container!.w)).toBeLessThan(1);
  expect(Math.abs(sizes.canvas.h - sizes.container!.h)).toBeLessThan(1);
  // Pixels réels du canevas : taille du conteneur x densité de l'écran (arrondie par Mapbox).
  expect(Math.abs(sizes.canvasPixels!.w - sizes.container!.w * sizes.pixelRatio)).toBeLessThan(2);
  expect(Math.abs(sizes.canvasPixels!.h - sizes.container!.h * sizes.pixelRatio)).toBeLessThan(2);
}

/** Vrai quand la vue aérienne a rattrapé son cadre (Mapbox se redimensionne après coup). */
async function orbitFollowsFrame(page: Page) {
  try {
    expectOrbitFollowsFrame(await orbitSizes(page));
    return true;
  } catch {
    return false;
  }
}

async function openExample(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const response = await page.goto("/annonce-exemple");
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

test.describe("visuel de tête de la fiche", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, "Les largeurs ordinateur sont fixées par le test.");
  });

  test("la photo garde une hauteur bornée à 1280 px, même si la colonne de droite s'allonge", async ({
    page,
  }) => {
    await openExample(page, 1280);
    const photo = mainVisual(page, "photos");
    await expect(photo).toBeVisible();

    const before = await heightOf(page, "photos");
    expect(before).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(before).toBeLessThanOrEqual(MAX_HEIGHT);

    // La colonne de droite (synthèse, mise à prix, audience…) devient beaucoup plus haute qu'aucun
    // visuel : le bloc de gauche ne la suit pas.
    const columnHeight = await photo.evaluate((element) => {
      const upper = element.closest('[class*="heroGallery"]')?.parentElement;
      const side = upper?.lastElementChild as HTMLElement | null;
      if (!side) return 0;
      side.style.minHeight = "2000px";
      return side.getBoundingClientRect().height;
    });
    expect(columnHeight).toBeGreaterThanOrEqual(2000);
    expect(await heightOf(page, "photos")).toBe(before);
  });

  for (const [width, min, max] of [
    [1024, MIN_HEIGHT, MAX_HEIGHT],
    [1440, MIN_HEIGHT, MAX_HEIGHT],
    [1920, MIN_HEIGHT, MAX_HEIGHT],
    [820, 500, 500],
  ] as const) {
    test(`la photo mesure ${min === max ? min : `${min} à ${max}`} px à ${width} px de large`, async ({
      page,
    }) => {
      await openExample(page, width);
      await expect(mainVisual(page, "photos")).toBeVisible();
      const height = await heightOf(page, "photos");
      expect(height).toBeGreaterThanOrEqual(min);
      expect(height).toBeLessThanOrEqual(max);
    });
  }

  test("la vue 360° garde sa hauteur et son canevas suit son cadre après un changement d'onglet et un redimensionnement", async ({
    page,
  }) => {
    await openExample(page, 1280);
    const tabs = page.getByRole("group", { name: "Visuel du bien" });
    // Sans jeton Mapbox (build de test par défaut), la fiche n'a pas d'onglet « Vue 360° ».
    test.skip(
      (await tabs.count()) === 0,
      "Pas de vue aérienne : aucun jeton Mapbox dans ce build.",
    );

    const photosTab = tabs.getByRole("button", { name: "Photos" });
    const orbitTab = tabs.getByRole("button", { name: "Vue 360°" });
    const orbit = mainVisual(page, "vue");

    await orbitTab.click();
    await expect(orbit).toBeVisible();
    const height = await heightOf(page, "vue");
    expect(height).toBeGreaterThanOrEqual(MIN_HEIGHT);
    expect(height).toBeLessThanOrEqual(MAX_HEIGHT);
    await expect.poll(() => orbitFollowsFrame(page)).toBe(true);

    // Même hauteur que la photo : passer d'un onglet à l'autre ne fait pas sauter la page.
    await photosTab.click();
    await expect(mainVisual(page, "photos")).toBeVisible();
    expect(await heightOf(page, "photos")).toBe(height);

    // Fenêtre redimensionnée pendant que la vue est masquée (0 x 0), puis retour sur la vue.
    await page.setViewportSize({ width: 1440, height: 900 });
    await orbitTab.click();
    await expect(orbit).toBeVisible();
    await expect.poll(() => orbitFollowsFrame(page)).toBe(true);
    expect(await heightOf(page, "vue")).toBeLessThanOrEqual(MAX_HEIGHT);

    // Redimensionnement de la fenêtre pendant que la vue est affichée.
    for (const width of [1100, 820, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(orbit).toBeVisible();
      await expect.poll(() => orbitFollowsFrame(page)).toBe(true);
    }
  });
});
