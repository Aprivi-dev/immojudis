import { expect, test, type Page } from "@playwright/test";

const SUPABASE_URL = "https://ci.supabase.co";
const AUTH_STORAGE_KEY = "encheres-immo-auth";
const adminId = "76000000-0000-4000-8000-000000000099";

/**
 * Module « Emails » de l'administration : l'aperçu d'un email s'affiche dans une iframe `srcdoc`
 * sandbox, sous la vraie politique de sécurité (CSP) du site, et le script d'un email n'y tourne pas.
 * Les réponses de l'API sont simulées : le rendu serveur des gabarits est couvert par Vitest.
 */
const designs = {
  dark: false,
  intro: "Aperçus rendus par les vrais gabarits.",
  templates: [
    {
      key: "alert",
      label: "Alerte de recherche",
      description: "Une alerte.",
      badges: [{ text: "Catégorie : alert", tone: "neutral" }],
      variants: [
        {
          key: "one-sale",
          label: "Une vente",
          subject: "Objet de l’alerte",
          html: `<!doctype html><html><head><style>.titre { color: rgb(1, 2, 3); }</style></head><body><h1 class="titre">Aperçu de l’alerte</h1><script>window.parent.__apercuExecute = true</script></body></html>`,
          text: "",
        },
      ],
    },
  ],
};

const addresses = {
  footnote: "Vérifié le 2 novembre 2026 à 11:00 (résultat gardé 60 s).",
  alerts: ["Aucun DMARC publié pour immojudis.com."],
  sections: [
    {
      title: "Secrets",
      items: [
        {
          title: "Envoi des emails",
          code: "RESEND_API_KEY",
          badges: [{ text: "Renseigné", tone: "ok" }],
          lines: [],
        },
      ],
    },
  ],
};

test.describe("admin emails", () => {
  test("shows the email previews in a sandboxed iframe under the site CSP", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    await prepareAdminEmails(page);

    await page.goto("/admin/emails");
    await expect(page.getByRole("heading", { name: "Emails", exact: true })).toBeVisible();
    const frame = page.locator("iframe[title='Aperçu : Une vente']");
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(frame).not.toHaveAttribute("src", /.+/);

    const heading = page.frameLocator("iframe[title='Aperçu : Une vente']").getByRole("heading");
    await expect(heading).toHaveText("Aperçu de l’alerte");
    await expect(heading).toHaveCSS("color", "rgb(1, 2, 3)");

    // Le script de l'email ne s'exécute pas : l'iframe n'a aucun droit.
    expect(await page.evaluate(() => "__apercuExecute" in window)).toBe(false);
    expect(violations.filter((text) => !/sandboxed/i.test(text))).toEqual([]);
  });

  test("switches tabs and keeps the tab in the address", async ({ page }) => {
    await prepareAdminEmails(page);
    await page.goto("/admin/emails?onglet=adresses");

    await expect(page.getByRole("tab", { name: "Adresses" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText("Aucun DMARC publié pour immojudis.com.")).toBeVisible();
    await expect(page.getByText("RESEND_API_KEY")).toBeVisible();

    await page.getByRole("tab", { name: "Historique" }).click();
    await expect(page.getByText("Vos alertes du jour")).toBeVisible();
    await expect(page).toHaveURL(/onglet=historique/);
  });

  test("shows the history, opens a sent email in an isolated frame and a received one as text", async ({
    page,
  }) => {
    await prepareAdminEmails(page);
    await page.goto("/admin/emails?onglet=historique");

    await expect(page.getByText("Vos alertes du jour")).toBeVisible();
    await expect(page.getByText("Remis", { exact: true })).toBeVisible();

    await page.getByText("Vos alertes du jour").click();
    const frame = page.locator("iframe[title='Contenu de l’email']");
    await expect(frame).toHaveAttribute("sandbox", "");
    await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await expect(
      page.frameLocator("iframe[title='Contenu de l’email']").getByRole("heading"),
    ).toHaveText("Bonjour");
    // Aucun lien d'action actif dans le cadre : le jeton est masqué et le lien est inerte.
    await expect(
      page.frameLocator("iframe[title='Contenu de l’email']").locator("a[href]"),
    ).toHaveCount(0);
    expect(await page.evaluate(() => "__historiqueExecute" in window)).toBe(false);

    await page.getByRole("button", { name: "Reçus" }).click();
    await page.getByText("Re: vente du 12 janvier").click();
    await expect(page.getByText("Texte reçu en clair, sans lien cliquable.")).toBeVisible();
    await expect(page.locator("iframe[title='Contenu de l’email']")).toHaveCount(0);
    await expect(page.getByText("pv-descriptif.pdf (240 Ko)")).toBeVisible();
  });
});

const sentHistory = {
  rows: [
    {
      id: "log:00000000-0000-4000-8000-000000000001",
      at: "02/11/2026 09:12",
      who: "alice@example.test",
      subject: "Vos alertes du jour",
      tag: "Alerte de recherche",
      status: { text: "Remis", tone: "ok" },
    },
  ],
  next: null,
};
const receivedHistory = {
  rows: [
    {
      id: "case:00000000-0000-4000-8000-000000000002",
      at: "02/11/2026 08:40",
      who: "maitre@cabinet.example",
      subject: "Re: vente du 12 janvier",
      tag: "Réponse à l’agent · 1 pièce(s)",
    },
  ],
  next: null,
};
const sentMessage = {
  title: "Vos alertes du jour",
  lines: ["À : alice@example.test", "Envoyé le 02/11/2026 09:12 · Alerte de recherche · Remis"],
  kind: "html",
  body: `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><h1>Bonjour</h1><script>window.parent.__historiqueExecute = true</script><a data-inert-href="[lien d’action masqué]">Se désinscrire</a>`,
  attachments: [],
};
const receivedMessage = {
  title: "Re: vente du 12 janvier",
  lines: ["De : maitre@cabinet.example", "Reçu le 02/11/2026 08:40"],
  kind: "text",
  body: "Texte reçu en clair, sans lien cliquable.",
  attachments: ["pv-descriptif.pdf (240 Ko)"],
};

async function prepareAdminEmails(page: Page) {
  const session = createSession();
  await page.addInitScript(
    ({ storageKey, storedSession }) => {
      window.localStorage.setItem(storageKey, JSON.stringify(storedSession));
    },
    { storageKey: AUTH_STORAGE_KEY, storedSession: session },
  );
  await page.route(`${SUPABASE_URL}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/auth/v1/user") {
      await route.fulfill({ status: 200, json: { user: session.user } });
      return;
    }
    if (url.pathname === "/auth/v1/token") {
      await route.fulfill({ status: 200, json: session });
      return;
    }
    if (url.pathname === "/rest/v1/user_profiles") {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "application/json", "content-range": "0-0/1" },
        json: [
          {
            user_id: adminId,
            email: session.user.email,
            full_name: "Administrateur E2E",
            account_type: "b2c",
            account_tier: "premium",
            user_role: "admin",
            professional_role: null,
            organization_name: null,
            professional_status: "not_applicable",
            created_at: "2026-09-19T09:00:00.000Z",
            updated_at: "2026-09-19T09:00:00.000Z",
          },
        ],
      });
      return;
    }
    await route.fulfill({ status: 200, json: [] });
  });
  await page.route("**/api/admin/emails/designs**", (route) => route.fulfill({ json: designs }));
  await page.route("**/api/admin/emails/addresses**", (route) =>
    route.fulfill({ json: addresses }),
  );
  await page.route("**/api/admin/emails/history**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/history")) {
      return route.fulfill({
        json: url.searchParams.get("box") === "received" ? receivedHistory : sentHistory,
      });
    }
    return route.fulfill({
      json: decodeURIComponent(url.pathname).includes("case:") ? receivedMessage : sentMessage,
    });
  });
}

function createSession() {
  const email = "admin.e2e@example.test";
  const user = {
    id: adminId,
    aud: "authenticated",
    role: "authenticated",
    email,
    email_confirmed_at: "2026-09-19T09:00:00.000Z",
    created_at: "2026-09-19T09:00:00.000Z",
    updated_at: "2026-09-19T09:00:00.000Z",
    app_metadata: { provider: "email", providers: ["email"], role: "admin" },
    user_metadata: { account_type: "b2c", full_name: "Administrateur E2E" },
  };
  return {
    access_token: fakeJwt({ sub: adminId, email, role: "authenticated" }),
    refresh_token: "refresh-e2e",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user,
  };
}

function fakeJwt(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    ...payload,
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.signature`;
}
