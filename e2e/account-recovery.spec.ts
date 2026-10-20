import { expect, test } from "@playwright/test";
import { pageStatus } from "./support/toast";

const email = "nouveau.compte.e2e@example.test";
const password = "un-mot-de-passe-solide";

test("mot de passe oublié : message neutre, sans dire si le compte existe", async ({ page }) => {
  const recoveries: string[] = [];
  await page.route("https://ci.supabase.co/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/recover") {
      recoveries.push(route.request().postData() ?? "");
      await route.fulfill({ status: 200, json: {} });
      return;
    }
    await route.fulfill({ status: 200, json: [] });
  });

  await page.goto("/mot-de-passe-oublie");
  await page.getByLabel("Adresse email du compte").fill("quelquun@example.test");
  await page.getByRole("button", { name: "Recevoir le lien de réinitialisation" }).click();

  await expect(pageStatus(page)).toContainText("Si un compte correspond");
  expect(recoveries).toHaveLength(1);
  expect(recoveries[0]).toContain("quelquun@example.test");
});

test("lien de réinitialisation expiré : un seul message et le chemin pour en redemander un", async ({
  page,
}) => {
  await page.route("https://ci.supabase.co/**", (route) =>
    route.fulfill({ status: 200, json: { data: { session: null } } }),
  );

  await page.goto("/reinitialiser-mot-de-passe#error=access_denied&error_code=otp_expired");

  await expect(page.getByText(/Ce lien est invalide ou a expiré/)).toHaveCount(1);
  // Next.js ajoute son propre annonceur de route (role="alert", vide) : on ne compte que la page.
  await expect(page.locator("main").getByRole("alert")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Enregistrer le mot de passe" })).toHaveCount(0);
  await page.getByRole("link", { name: "Demander un nouveau lien" }).click();
  await expect(page).toHaveURL(/\/mot-de-passe-oublie/);
});

test.describe("inscription avec confirmation par email", () => {
  test.beforeEach(async ({ page }) => {
    // Confirmation activée : Supabase renvoie l'utilisateur sans session.
    await page.route("https://ci.supabase.co/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/auth/v1/signup") {
        await route.fulfill({
          status: 200,
          json: {
            id: "76000000-0000-4000-8000-000000000042",
            aud: "authenticated",
            role: "",
            email,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            app_metadata: { provider: "email", providers: ["email"] },
            user_metadata: {},
          },
        });
        return;
      }
      if (url.pathname === "/auth/v1/resend") {
        await route.fulfill({ status: 200, json: { message_id: "e2e" } });
        return;
      }
      await route.fulfill({ status: 200, json: [] });
    });
  });

  test("explique le motif, remplace le formulaire par un panneau et permet de renvoyer l'email", async ({
    page,
  }) => {
    // Horloge simulée : « Renvoyer l'email » est bloqué 30 s après l'envoi.
    await page.clock.install();
    await page.goto("/login?mode=investor&reason=alerte");

    await expect(page.getByTestId("login-reason")).toHaveText(
      "Créez votre compte gratuit pour enregistrer cette alerte, sans carte bancaire.",
    );
    await expect(page.getByText("Au moins 12 caractères.")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Créer un compte", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");

    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Mot de passe", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Créer mon compte gratuit" }).click();

    const panel = pageStatus(page);
    await expect(panel).toContainText(
      `Un email de confirmation a été envoyé à ${email}, cliquez sur le lien pour continuer.`,
    );
    await expect(page.getByLabel("Mot de passe", { exact: true })).toHaveCount(0);

    await expect(page.getByRole("button", { name: /Renvoyer l'email \(\d+ s\)/ })).toBeDisabled();
    await page.clock.fastForward(30_000);
    await page.getByRole("button", { name: "Renvoyer l'email" }).click();
    await expect(panel).toContainText(`Email renvoyé à ${email}`);

    await page.getByRole("button", { name: "Changer d'adresse" }).click();
    await expect(page.getByLabel("Email")).toHaveValue(email);
    await expect(pageStatus(page)).toHaveCount(0);
  });

  test("garde des cibles tactiles d'au moins 44 px sur le formulaire", async ({ page }) => {
    await page.goto("/login?mode=investor");

    for (const control of [
      page.getByRole("button", { name: "Afficher le mot de passe" }),
      page.getByRole("button", { name: "Se connecter", exact: true }).first(),
      page.getByRole("button", { name: "Créer un compte", exact: true }),
    ]) {
      const box = await control.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(43.5);
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(43.5);
    }
  });
});
