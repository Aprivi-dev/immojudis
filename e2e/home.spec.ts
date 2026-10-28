import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  OCCUPATION_LABEL,
  PROJECT_LABEL,
  WORKS_LABEL,
} from "@/components/home/example-verdict-text";
import { BID_VERDICT_LABEL } from "@/lib/bid-verdict";

/**
 * Accueil : « Essayez sur un exemple » (réglages, verdict, démonstration qui s'arrête au premier
 * choix), situations du premier écran, mouvement réduit et largeur de 320 px. Aucun appel à la base :
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
    const verdict = section.locator("[class*=tryVerdict]").first();
    await expect(verdict).toHaveAttribute("aria-live", "off");

    await expect(async () => {
      await tryGroup(page, "Projet").getByRole("button", { name: PROJECT_LABEL.revendre }).click();
      await expect(verdict).toHaveAttribute("aria-live", "polite", { timeout: 1000 });
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

test.describe("premier écran : situations de l'exemple", () => {
  const situations = (page: Page) => page.getByRole("group", { name: "Situations de l’exemple" });

  test("un bouton choisit la situation, qui ne change plus ensuite", async ({ page }) => {
    await page.clock.install();
    await page.goto("/");
    const buttons = situations(page).getByRole("button");
    await expect(buttons.first()).toHaveAttribute("aria-pressed", "true");
    const count = await buttons.count();
    expect(count).toBeGreaterThanOrEqual(2);

    const target = buttons.nth(1);
    await expect(async () => {
      await target.click();
      await expect(target).toHaveAttribute("aria-pressed", "true", { timeout: 1000 });
    }).toPass();
    await expect(buttons.first()).toHaveAttribute("aria-pressed", "false");

    await page.clock.fastForward(30_000);
    await expect(target).toHaveAttribute("aria-pressed", "true");
    await expect(buttons.first()).toHaveAttribute("aria-pressed", "false");
  });

  test("les situations défilent seules sans choix du visiteur", async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name.startsWith("mobile"),
      "le défilement se lit sur un seul projet",
    );
    await page.clock.install();
    await page.goto("/");
    const buttons = situations(page).getByRole("button");
    await expect(buttons.first()).toHaveAttribute("aria-pressed", "true");
    await expect(async () => {
      await page.clock.fastForward(4000);
      await expect(buttons.first()).toHaveAttribute("aria-pressed", "false", { timeout: 500 });
    }).toPass({ timeout: 20_000 });
  });
});

test.describe("mouvement réduit", () => {
  test.use({ reducedMotion: "reduce" });

  test("aucune démonstration ne défile, ni au premier écran ni dans « Essayez »", async ({
    page,
  }) => {
    await page.clock.install();
    await page.goto("/");
    const section = page.locator("#essayer");
    await section.scrollIntoViewIfNeeded();
    const hero = situations(page);
    const heroBefore = await hero.locator("button[aria-pressed=true]").innerText();
    const tryBefore = await lastPressed(tryGroup(page, "Occupation")).innerText();

    await page.clock.fastForward(60_000);

    await expect(hero.locator("button[aria-pressed=true]")).toHaveText(heroBefore);
    await expect(lastPressed(tryGroup(page, "Occupation"))).toHaveText(tryBefore);
  });

  function situations(page: Page) {
    return page.getByRole("group", { name: "Situations de l’exemple" });
  }
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
