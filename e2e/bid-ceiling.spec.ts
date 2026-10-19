import { expect, test, type Page } from "@playwright/test";

// Parcours du calcul de l'enchère plafond sur l'annonce exemple : elle est rendue sans compte ni
// appel réseau (annonce fictive, estimation DVF d'exemple), donc stable en CI.
//
// Les cas « Maison avec terrain » et « Louer sans loyer de référence » demandent une vente dont la
// fiche est lue par le serveur dans Supabase (`lookupPublicSale`) : avec l'URL factice de la CI,
// cette lecture échoue côté serveur et la page répond 500, ce qu'un `page.route` ne peut pas
// simuler. Ils sont couverts par `surface.test.ts`, `bid-ceiling-defaults.test.ts`,
// `bid-ceiling-engine.test.ts`, `CeilingHypothesesPanel.test.tsx` et `CeilingPlanner.test.tsx`.

async function openCalculation(page: Page) {
  await page.goto("/annonce-exemple#calculation");
  const calculation = page.locator("#calculation");
  await expect(page.getByRole("heading", { name: "Votre enchère plafond" })).toBeVisible();
  await expect(calculation).toContainText(/Enchère plafond · Équilibré/);
  return calculation;
}

test("l'enchère plafond de l'exemple est chiffrée, avec ses lignes dépliables et ses définitions", async ({
  page,
}) => {
  const calculation = await openCalculation(page);

  await expect(calculation).not.toContainText("À compléter");
  await expect(calculation).not.toContainText("Marge de sécurité non tenue");
  await expect(calculation.getByText(/\d.*€/).first()).toBeVisible();

  // Chaque ligne du calcul se déplie.
  const firstStep = calculation.locator("#why-this-ceiling summary").first();
  await firstStep.click();
  await expect(firstStep.locator("xpath=..")).toHaveJSProperty("open", true);

  // Un terme du métier s'explique et renvoie vers le guide.
  await calculation.getByRole("button", { name: "Définition : adjudication" }).click();
  const definition = calculation.getByRole("note");
  await expect(definition).toContainText("Attribution du bien au meilleur enchérisseur");
  await expect(definition.getByRole("link", { name: "En savoir plus" })).toHaveAttribute(
    "href",
    "/ventes-immobilieres-judiciaires#lexique-adjudication",
  );
  await page.keyboard.press("Escape");
  await expect(definition).toHaveCount(0);
});

test("vider « Frais préalables » ne réinjecte pas le défaut, on peut ressaisir", async ({
  page,
}) => {
  const calculation = await openCalculation(page);
  await calculation.getByRole("button", { name: "Modifier les hypothèses" }).click();

  // « exact » : les définitions du glossaire (« Définition : frais préalables ») ont aussi ce libellé.
  const fees = page.getByLabel("Frais préalables", { exact: true });
  const defaultFees = await fees.inputValue();
  expect(Number(defaultFees)).toBeGreaterThan(0);

  await fees.fill("");
  await expect(fees).toHaveValue("");
  await expect(fees).toHaveAttribute("placeholder", defaultFees);

  await fees.fill("800");
  await expect(fees).toHaveValue("800");
  await fees.press("Tab");
  await expect(fees).toHaveValue("800");

  // Laissé vide en quittant le champ, il retrouve sa valeur par défaut.
  await fees.fill("");
  await fees.press("Tab");
  await expect(fees).toHaveValue(defaultFees);
});

test("un prix au m² ou un loyer à 0 compte pour « non saisi »", async ({ page }) => {
  const calculation = await openCalculation(page);
  await calculation.getByRole("radio", { name: /Louer/ }).click();
  await calculation.getByRole("button", { name: "Modifier les hypothèses" }).click();

  const price = page.getByLabel("Prix au m² du bien");
  const estimatedPrice = await price.inputValue();
  await price.fill("9999");
  await expect(calculation.getByText(/Votre prix remplace l’estimation/)).toBeVisible();
  await price.fill("0");
  await expect(calculation.getByText(/Votre prix remplace l’estimation/)).toHaveCount(0);
  await price.press("Tab");
  await expect(price).toHaveValue(estimatedPrice);

  const rent = page.getByLabel("Loyer mensuel hors charges");
  const referenceRent = await rent.inputValue();
  await rent.fill("0");
  await rent.press("Tab");
  await expect(rent).toHaveValue(referenceRent);
  await expect(
    calculation.getByText(
      "Loyer non renseigné : le plafond ne tient pas compte du rendement. Saisissez un loyer.",
    ),
  ).toHaveCount(0);
});
