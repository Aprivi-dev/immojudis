import { expect, test } from "@playwright/test";

/**
 * Accueil : premier écran peint, mouvement réduit et largeur de 320 px. Aucun appel à la base.
 */

test.describe("premier écran : la peinture et ses actions", () => {
  test("mène au catalogue et à l'analyse exemple, et propose l'inscription", async ({ page }) => {
    await page.goto("/");
    const hero = page.locator("section", { has: page.locator("#home-title") });
    await expect(hero.getByRole("link", { name: "Voir les ventes" })).toHaveAttribute(
      "href",
      "/sales",
    );
    await expect(hero.getByRole("link", { name: "Une analyse exemple" })).toHaveAttribute(
      "href",
      "/annonce-exemple",
    );
    await expect(hero.getByRole("link", { name: "Créer mon compte gratuit" })).toBeVisible();
  });

  test("la boucle vidéo de la peinture n'est chargée que par le script, sur l'image fixe", async ({
    page,
  }) => {
    await page.goto("/");
    const hero = page.locator("section", { has: page.locator("#home-title") });
    await expect(hero.getByRole("img", { name: /^Peinture : la Justice/ })).toBeVisible();
    const loop = hero.locator("video[data-home-loop]");
    // Le rendu serveur ne donne pas d'adresse à la vidéo : le script la pose à l'approche de l'écran.
    await expect(loop).toHaveAttribute("src", /\/media\/landing\/accueil\/01-hero\.mp4$/);
    await expect(page.locator("html")).toHaveAttribute("data-home-scenes", "");
  });
});

test.describe("mouvement réduit", () => {
  test.use({ reducedMotion: "reduce" });

  test("rien ne s'anime : ni les scènes, ni les boucles vidéo", async ({ page }) => {
    await page.goto("/");
    await page.locator("#etapes").scrollIntoViewIfNeeded();
    // Les scènes épinglées ne sont pas activées, et aucune boucle vidéo n'a reçu d'adresse.
    await expect(page.locator("html")).not.toHaveAttribute("data-home-scenes", "");
    await expect(page.locator("video[data-home-loop][src]")).toHaveCount(0);
    // Tout ce que la scène du dossier réunit reste lisible, posé dans la page.
    await expect(page.getByText("Cahier des conditions de vente", { exact: true })).toBeVisible();
  });
});

test.describe("largeur de 320 px", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("l'accueil ne déborde pas à l'horizontale", async ({ page }) => {
    await page.goto("/");
    // Fait défiler la page pour que chaque section se révèle avant la mesure.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 500) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
    }
    const sizes = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
});
