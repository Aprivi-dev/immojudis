import { describe, expect, it } from "vitest";
import { MASKED_LINK, maskActionLinks, toInertEmailDocument } from "./link-masking";

const ACTION_LINKS = [
  // Désinscription signée et clic suivi des emails d'alerte.
  "https://immojudis.test/api/notification-preferences/unsubscribe?token=abc.def",
  "https://immojudis.test/api/email/click?token=eyJhbGciOiJIUzI1NiJ9.payload.signature",
  // Opposition et dépôt de l'agent.
  "https://immojudis.test/api/information-agent/opt-out?e=bWFpdHJl&t=0a1b2c",
  "https://immojudis.test/depot/3f2a9c1e7b4d4e0f9a6b5c4d3e2f1a0b",
  // Authentification : confirmation d'adresse, lien magique, réinitialisation.
  "https://projet.supabase.co/auth/v1/verify?token=pkce_abc&type=signup&redirect_to=https://immojudis.test",
  "https://immojudis.test/auth/confirm?token_hash=abcdef&type=recovery",
  "https://immojudis.test/reinitialiser-mot-de-passe#access_token=abc",
  // Partage de rapport.
  "https://immojudis.test/partage/rapport/AbCdEfGhIjKlMnOpQrStUvWxYz012345",
];

describe("maskActionLinks", () => {
  it.each(ACTION_LINKS)("masque %s", (url) => {
    const masked = maskActionLinks(`Cliquez ici : ${url} merci`);
    expect(masked).toBe(`Cliquez ici : ${MASKED_LINK} merci`);
    expect(masked).not.toContain("token");
  });

  it("masque une URL dans un attribut HTML, avec ses & encodés", () => {
    const html = '<a href="https://immojudis.test/x?a=1&amp;t=secret">Se désinscrire</a>';
    expect(maskActionLinks(html)).toBe(`<a href="${MASKED_LINK}">Se désinscrire</a>`);
  });

  it("masque aussi une URL illisible, dans le doute", () => {
    expect(maskActionLinks("http://[::1")).toContain(MASKED_LINK);
  });

  it("laisse une page publique ordinaire", () => {
    const text = "Voir https://immojudis.test/tribunaux/paris et https://immojudis.test/";
    expect(maskActionLinks(text)).toBe(text);
  });
});

describe("toInertEmailDocument", () => {
  const hostile = `
    <html><head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">
    <link rel="stylesheet" href="https://evil.test/a.css"></head>
    <body onload="alert(1)">
      <script>fetch("https://immojudis.test/api/email/click?token=abc")</script>
      <a href="https://immojudis.test/api/notification-preferences/unsubscribe?token=abc">Se désinscrire</a>
      <a href="javascript:alert(1)">piège</a>
      <img src="https://immojudis.test/pixel.gif" alt="">
      <form action="https://evil.test"><input name="x"><button>OK</button></form>
      <iframe src="https://evil.test"></iframe>
      <p>Bonjour</p>
    </body></html>`;
  const document = toInertEmailDocument(hostile);

  it("n'en laisse aucun lien actif ni aucune ressource chargeable", () => {
    expect(document).not.toMatch(/\s(?:href|src|action|formaction)\s*=/i);
    expect(document).not.toMatch(/<(?:script|iframe|form|input|button|base|link)\b/i);
    expect(document).not.toContain("javascript:");
    expect(document).not.toMatch(/\son[a-z]+\s*=/i);
    expect(document).not.toContain("token=abc");
    expect(document).not.toContain("evil.test/a.css");
    expect(document).toContain(MASKED_LINK);
  });

  it("garde le texte lisible", () => {
    expect(document).toContain("Se désinscrire");
    expect(document).toContain("Bonjour");
  });

  it("interdit toute requête par une politique de sécurité du contenu", () => {
    expect(document).toMatch(/Content-Security-Policy" content="default-src 'none'/);
    expect(document).toContain("img-src data:");
  });
});
