import { describe, expect, it } from "vitest";
import { EMAIL_COLORS, EMAIL_FONT_STACK, emailBrandHeaderHtml } from "./email-brand";
import { informationAgentPage } from "./information-agent-public-page";

async function render(options: Parameters<typeof informationAgentPage>[0]) {
  const response = informationAgentPage(options);
  return { response, html: await response.text() };
}

describe("informationAgentPage", () => {
  it("porte les couleurs, la police et l'en-tête de la marque, sans l'ancienne charte", async () => {
    const { html } = await render({
      title: "Opposition enregistrée",
      message: "Vous ne recevrez plus de message.",
      status: 200,
      forms: [{ action: "/api/x?t=1", buttons: [{ label: "Confirmer", name: "a", value: "b" }] }],
      links: [{ href: "https://immojudis.com", label: "Retour au site" }],
    });
    expect(html).toContain(emailBrandHeaderHtml());
    expect(html).toContain(`font-family:${EMAIL_FONT_STACK}`);
    expect(html).toContain(`background:${EMAIL_COLORS.surface}`);
    expect(html).toContain(`background:${EMAIL_COLORS.navy};color:${EMAIL_COLORS.white}`);
    expect(html).toContain(`border:1px solid ${EMAIL_COLORS.lineWarm}`);
    // Ni l'ancien marine (#172036), ni l'ancien papier, ni Arial seul.
    expect(html).not.toMatch(/#172036|#f6f4ef|#e8e1d4|#182033/i);
    expect(html).not.toMatch(/font-family:Arial,sans-serif/);
  });

  it("garde le contenu échappé, la page hors index et sans cache", async () => {
    const { response, html } = await render({
      title: "<b>Titre</b>",
      message: 'Message "cité"',
      status: 410,
    });
    expect(response.status).toBe(410);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain("<b>Titre</b>");
    expect(html).toContain("&#60;b&#62;Titre&#60;/b&#62;");
  });
});
