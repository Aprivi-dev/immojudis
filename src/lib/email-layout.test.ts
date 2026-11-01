import { describe, expect, it } from "vitest";
import {
  emailButton,
  emailLayout,
  emailParagraph,
  emailPreheaderFrom,
  emailSaleCard,
  escapeEmailHtml,
} from "./email-layout";

const page = (options: Partial<Parameters<typeof emailLayout>[0]> = {}) =>
  emailLayout({
    title: "Objet <test>",
    preheader: "Un résumé court du message.",
    content: emailParagraph("Bonjour,"),
    footer: {
      reason: "Vous recevez ce message parce que.",
      links: [{ text: "Compte", href: "https://immojudis.com/compte" }],
    },
    ...options,
  });

describe("emailLayout", () => {
  it("pose le cadre commun : doctype, langue, métadonnées, titre échappé, mode sombre", () => {
    const html = page();
    expect(html).toMatch(/^<!doctype html>\n<html lang="fr">/);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toContain("<title>Objet &lt;test&gt;</title>");
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain("background-color: #07111f");
    expect(html).toContain("background-color: #132238");
  });

  it("met en page avec des tableaux, jamais des div, dans une carte de 600 px au filet or de 4 px", () => {
    const html = page();
    expect(html).not.toContain("<div");
    expect(html).toContain('width="600"');
    expect(html).toContain("max-width:600px");
    expect(html).toContain("border:1px solid #d8cfc1;border-radius:10px");
    expect(html).toMatch(/<td height="4" bgcolor="#c98d45"/);
    expect(html).toContain("background-color:#fbf9f5");
  });

  it("affiche le logo PNG cliquable avec son texte de repli, et sa variante sombre", () => {
    const html = page();
    expect(html).toContain('<a href="https://immojudis.com"');
    expect(html).toContain(
      'src="https://immojudis.com/brand/email/immojudis-logo-email-v1.png" width="144" height="32" alt="Immojudis"',
    );
    expect(html).toContain("immojudis-logo-email-dark-v1.png");
    expect(html).toContain(".logo-dark { display: block !important");
  });

  it("sans liens vers le site (agent d'information) : logo non cliquable, ligne de marque réduite au nom", () => {
    const html = page({ siteLinks: false });
    expect(html).not.toContain('href="https://immojudis.com"');
    expect(html).not.toContain("mailto:contact@immojudis.com");
    expect(html).not.toMatch(/>immojudis\.com</);
    expect(html).toContain(">Immojudis</td>");
  });

  it("masque un préheader de 100 caractères au plus, hors du texte brut", () => {
    const long = "Mot ".repeat(60);
    expect(emailPreheaderFrom(long).length).toBeLessThanOrEqual(100);
    expect(emailPreheaderFrom(long).endsWith("…")).toBe(true);
    expect(emailPreheaderFrom("Court.")).toBe("Court.");
    const html = page({ preheader: long });
    expect(html).toMatch(/<span data-skip-in-text="true" style="display:none;[^>]*mso-hide:all/);
  });

  it("imprime la ligne de marque et le pied, sauf pour un email interne (footer: null)", () => {
    const html = page();
    expect(html).toContain("Immojudis · ");
    expect(html).toContain("contact@immojudis.com");
    expect(html).toContain("Vous recevez ce message parce que.");
    const internal = page({ footer: null });
    expect(internal).not.toContain("contact@immojudis.com");
    expect(internal).not.toContain("Vous recevez ce message");
  });

  it("n'emploie jamais du blanc ni du noir pur en couleur de texte, hors bouton", () => {
    const html = page({
      content: emailParagraph("x") + emailButton("https://immojudis.com/a", "Voir l’annonce"),
    });
    const withoutButton = html.replace(/<a [^>]*class="ej-btn-a"[^>]*>/, "");
    expect(withoutButton).not.toMatch(/(?<![-\w])color:\s*(#fff(fff)?|#000(000)?)\b/i);
  });
});

describe("emailButton", () => {
  it("est blindé : cellule colorée, lien en bloc, bordure de la même couleur, 16/20 700, 12 px 20 px", () => {
    const html = emailButton("https://immojudis.com/a?b=1&c=2", "Voir l’annonce");
    expect(html).toContain('bgcolor="#132238"');
    expect(html).toContain("border:1px solid #132238;border-radius:6px");
    expect(html).toContain("display:inline-block;padding:12px 20px");
    expect(html).toContain("font-size:16px;line-height:20px;font-weight:700;color:#ffffff");
    expect(html).toContain('href="https://immojudis.com/a?b=1&amp;c=2"');
    expect(html).toContain(">Voir l’annonce</a>");
  });

  it("a une variante secondaire transparente à bordure marine", () => {
    const html = emailButton("https://immojudis.com/a", "Créer une alerte", {
      variant: "secondary",
    });
    expect(html).not.toContain("bgcolor");
    expect(html).toContain("border:1px solid #132238");
    expect(html).toContain("color:#132238;text-decoration:none");
  });
});

describe("emailSaleCard", () => {
  it("compose surtitre, titre, lieu, faits, mentions et un seul bouton, échappés", () => {
    const html = emailSaleCard({
      eyebrow: "Alerte <x>",
      title: "Maison & jardin",
      location: "Libourne · 33",
      facts: [{ label: "Audience", value: "10 décembre 2026" }, { value: "Seul" }],
      notesHtml: "<p>Mention</p>",
      action: { href: "https://immojudis.com/sales/1", text: "Voir l’annonce" },
    });
    expect(html).toContain("Alerte &lt;x&gt;");
    expect(html).toContain("Maison &amp; jardin");
    expect(html).toContain("Libourne · 33");
    expect(html).toContain("Audience : <strong");
    expect(html).toContain("<p>Mention</p>");
    expect(html.match(/class="ej-btn-a"/g)).toHaveLength(1);
    expect(html).toContain("border-top:1px solid #e1d8ca");
  });
});

describe("escapeEmailHtml", () => {
  it("échappe les cinq caractères sensibles", () => {
    expect(escapeEmailHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
