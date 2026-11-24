import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  OCCUPATION_LABEL,
  PROJECT_LABEL,
  WORKS_LABEL,
} from "@/components/home/example-verdict-text";
import { BID_VERDICT_LABEL } from "@/lib/bid-verdict";

/**
 * Accueil : « Essayez sur un exemple » (réglages, verdict, démonstration qui s'arrête au premier
 * choix), premier écran peint, mouvement réduit et largeur de 320 px. Aucun appel à la base :
 * la page se rend côté serveur avec l'annonce exemple.
 */

const lastPressed = (group: Locator) => group.locator("button[aria-pressed=true]");

function tryGroup(page: Page, name: "Projet" | "Occupation" | "Travaux") {
  return page.locator("#essayer").getByRole("group", { name });
}

async function chooseSituation(
  page: Page,
  project: keyof typeof PROJECT_LABEL,
  occupation: keyof typeof OCCUPATION_LABEL,
  works: keyof typeof WORKS_LABEL,
) {
  await tryGroup(page, "Projet").getByRole("button", { name: PROJECT_LABEL[project] }).click();
  await tryGroup(page, "Occupation")
    .getByRole("button", { name: OCCUPATION_LABEL[occupation] })
    .click();
  await tryGroup(page, "Travaux").getByRole("button", { name: WORKS_LABEL[works] }).click();
}

test.describe("« Essayez sur un exemple »", () => {
  test("un réglage recalcule le verdict : on enchérit, puis on passe son tour", async ({
    page,
  }) => {
    await page.goto("/");
    const section = page.locator("#essayer");
    await section.scrollIntoViewIfNeeded();
    const verdict = section.locator("[class*=tryVerdict]").first();

    // Un bien libre, un projet pour y habiter : le plafond dépasse largement la mise à prix.
    await expect(async () => {
      await chooseSituation(page, "habiter", "libre", "rafraichissement");
      await expect(verdict).toContainText(BID_VERDICT_LABEL.go, { timeout: 1500 });
    }).toPass();
    await expect(
      tryGroup(page, "Projet").getByRole("button", { name: PROJECT_LABEL.habiter }),
    ).toHaveAttribute("aria-pressed", "true");

    // Un bien occupé à louer avec des travaux de confort : la mise à prix dépasse déjà le plafond.
    await chooseSituation(page, "louer", "occupe", "confort");
    await expect(verdict).toContainText(BID_VERDICT_LABEL.pass);
    await expect(verdict).not.toContainText(BID_VERDICT_LABEL.go);
  });

  test("le premier choix arrête la démonstration et annonce le résultat aux lecteurs d'écran", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto("/");
    const section = page.locator("#essayer");
    await section.scrollIntoViewIfNeeded();
    const announcement = section.getByRole("status");
    await expect(announcement).toHaveCount(0);

    await expect(async () => {
      await tryGroup(page, "Projet").getByRole("button", { name: PROJECT_LABEL.revendre }).click();
      await expect(announcement).toHaveCount(1, { timeout: 1000 });
    }).toPass();

    // Rien ne bouge plus tout seul : le réglage du visiteur reste celui affiché.
    await page.clock.fastForward(60_000);
    await expect(lastPressed(tryGroup(page, "Projet"))).toHaveText(PROJECT_LABEL.revendre);
  });

  test("la démonstration défile d'elle-même tant que personne n'a choisi", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith("mobile"),
      "le défilement se lit sur un seul projet",
    );
    await page.clock.install();
    await page.goto("/");
    const section = page.locator("#essayer");
    await section.scrollIntoViewIfNeeded();
    const before = await lastPressed(tryGroup(page, "Occupation")).innerText();
    await expect(async () => {
      await page.clock.fastForward(4000);
      await expect(lastPressed(tryGroup(page, "Occupation"))).not.toHaveText(before, {
        timeout: 500,
      });
    }).toPass({ timeout: 20_000 });
  });
});

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

  test("rien ne défile ni ne s'anime : ni « Essayez », ni les scènes, ni les boucles vidéo", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto("/");
    const section = page.locator("#essayer");
    await section.scrollIntoViewIfNeeded();
    const tryBefore = await lastPressed(tryGroup(page, "Occupation")).innerText();

    await page.clock.fastForward(60_000);

    await expect(lastPressed(tryGroup(page, "Occupation"))).toHaveText(tryBefore);
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
