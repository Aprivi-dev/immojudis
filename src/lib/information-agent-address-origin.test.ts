import { describe, expect, it } from "vitest";
import {
  formatInformationAgentOriginDate,
  informationAgentAddressOrigin,
  informationAgentLegalFooterLines,
  informationAgentLegalFooterSections,
  INFORMATION_AGENT_ADDRESS_SOURCE_KINDS,
  type InformationAgentLegalFooter,
} from "@/lib/information-agent-compliance";

const OBSERVED_AT = "2026-10-14T21:30:00Z";

describe("libellé d'origine de l'adresse (art. 14 RGPD)", () => {
  it("formate la date de relevé à l'heure de Paris", () => {
    expect(formatInformationAgentOriginDate(OBSERVED_AT)).toBe("14/10/2026");
    // 22 h 30 UTC le 14 octobre = 00 h 30 le 15 octobre à Paris (heure d'été).
    expect(formatInformationAgentOriginDate("2026-10-14T22:30:00Z")).toBe("15/10/2026");
    expect(formatInformationAgentOriginDate(null)).toBeNull();
    expect(formatInformationAgentOriginDate("pas une date")).toBeNull();
  });

  it("annonce de la vente : l'annonce, son lien et la date de consultation", () => {
    expect(
      informationAgentAddressOrigin({
        sourceKind: "sale_listing",
        sourceName: "licitor",
        sourceUrl: "https://www.licitor.com/annonce/1",
        observedAt: OBSERVED_AT,
        observedBy: "agent",
      }),
    ).toEqual({
      text: "Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor (https://www.licitor.com/annonce/1), consultée le 14/10/2026.",
      url: "https://www.licitor.com/annonce/1",
      automated: false,
    });
  });

  it("autre annonce du même professionnel : jamais présentée comme l'annonce de la vente", () => {
    const origin = informationAgentAddressOrigin({
      sourceKind: "other_listing",
      sourceName: "licitor",
      sourceUrl: "https://www.licitor.com/annonce/2",
      observedAt: OBSERVED_AT,
      observedBy: "agent",
    });
    expect(origin.text).toBe(
      "Votre adresse professionnelle figure dans une autre annonce publique de vente que vous avez publiée, sur Licitor (https://www.licitor.com/annonce/2), consultée le 14/10/2026.",
    );
    expect(origin.text).not.toContain("annonce publique de cette vente");
    expect(origin.automated).toBe(true);
  });

  it.each([
    [
      "annuaire officiel des commissaires de justice",
      "https://annuaire.commissaire-justice.fr/etude-1",
      "Votre adresse professionnelle figure sur votre fiche publique de l’annuaire officiel des commissaires de justice (https://annuaire.commissaire-justice.fr/etude-1), consultée le 14/10/2026.",
    ],
    [
      "annuaire du barreau de Lyon",
      "https://www.barreaulyon.com/annuaire/avocat/jean-dupont/",
      "Votre adresse professionnelle figure sur votre fiche publique de l’annuaire du barreau de Lyon (https://www.barreaulyon.com/annuaire/avocat/jean-dupont/), consultée le 14/10/2026.",
    ],
  ])("annuaire officiel nommé : %s", (directoryName, sourceUrl, text) => {
    const origin = informationAgentAddressOrigin({
      sourceKind: "official_directory",
      directoryName,
      sourceUrl,
      observedAt: OBSERVED_AT,
      observedBy: "agent",
    });
    expect(origin.text).toBe(text);
    expect(origin.text).not.toContain("figure dans l’annonce");
    expect(origin.automated).toBe(true);
  });

  it("site du cabinet : consulté le, avec le lien", () => {
    expect(
      informationAgentAddressOrigin({
        sourceKind: "firm_website",
        sourceUrl: "https://cabinet-dupont.example.test/contact",
        observedAt: OBSERVED_AT,
        observedBy: "agent",
      }).text,
    ).toBe(
      "Votre adresse professionnelle figure sur le site de votre cabinet (https://cabinet-dupont.example.test/contact), consulté le 14/10/2026.",
    );
  });

  it("saisie d'un administrateur : relevée par l'équipe, à la date de la saisie, sans recherche automatique", () => {
    const origin = informationAgentAddressOrigin({
      sourceKind: "admin_entry",
      sourceUrl: "https://annuaire.example.test/me-x",
      observedAt: OBSERVED_AT,
      observedBy: "admin",
    });
    expect(origin.text).toBe(
      "Votre adresse professionnelle a été relevée par un membre de l’équipe Immojudis sur une page publique (https://annuaire.example.test/me-x), le 14/10/2026.",
    );
    expect(origin.automated).toBe(false);
  });

  it("n'annonce la recherche automatique que pour une adresse trouvée par l'agent hors annonce", () => {
    const common = { sourceUrl: "https://www.licitor.com/annonce/1", observedAt: OBSERVED_AT };
    expect(
      informationAgentAddressOrigin({ ...common, sourceKind: "sale_listing", observedBy: "agent" })
        .automated,
    ).toBe(false);
    expect(
      informationAgentAddressOrigin({ ...common, sourceKind: "firm_website", observedBy: "admin" })
        .automated,
    ).toBe(false);
    expect(
      informationAgentAddressOrigin({ ...common, sourceKind: "firm_website", observedBy: "agent" })
        .automated,
    ).toBe(true);
  });

  it("couvre chaque type de source et ignore un lien non http(s)", () => {
    for (const sourceKind of INFORMATION_AGENT_ADDRESS_SOURCE_KINDS) {
      const origin = informationAgentAddressOrigin({
        sourceKind,
        directoryName: "annuaire officiel X",
        sourceUrl: "javascript:alert(1)",
        observedAt: OBSERVED_AT,
      });
      expect(origin.url).toBeNull();
      expect(origin.text.length).toBeGreaterThan(20);
    }
  });
});

describe("pied de message art. 14 : version complète", () => {
  const footer: InformationAgentLegalFooter = {
    controllerName: "Immojudis SAS",
    controllerAddress: "1 rue de la Paix, 75002 Paris",
    contactEmail: "contact@immojudis.test",
    saleReference: "Appartement T3 à Bordeaux — Tribunal judiciaire de Bordeaux",
    addressOrigin: "Origine X.",
    addressOriginUrl: "https://www.licitor.com/annonce/1",
    aiProvider: { id: "replicate", name: "Replicate", country: "États-Unis" },
    privacyUrl: "https://immojudis.com/privacy",
    optOutUrl: "https://immojudis.com/api/information-agent/opt-out?e=a&t=b",
  };

  it("couvre finalité, catégories, origine, destinataires, conservation, droits, opposition et CNIL", () => {
    const text = informationAgentLegalFooterLines(footer).join("\n");
    expect(text).toContain(
      "Pourquoi ce message ? Immojudis vous écrit à titre professionnel pour vérifier des informations sur la vente Appartement T3 à Bordeaux",
    );
    expect(text).toContain("Ce message ne contient aucune offre commerciale.");
    expect(text).toContain("intérêt légitime à publier des informations exactes (art. 6.1.f RGPD)");
    expect(text).toContain(
      "Responsable de traitement : Immojudis SAS, 1 rue de la Paix, 75002 Paris — contact@immojudis.test.",
    );
    expect(text).toContain(
      "Vos données : votre nom, votre fonction, votre adresse professionnelle et nos échanges. Origine : Origine X.",
    );
    expect(text).toContain("Destinataires : l’équipe Immojudis et ses prestataires");
    expect(text).toContain("Vercel et Supabase (hébergement), Resend (envoi des courriels)");
    expect(text).toContain("Replicate (États-Unis), outil d’IA");
    expect(text).toContain("hors de l’Union européenne");
    expect(text).toContain(
      "Conservation : 30 jours si aucun message ne vous est finalement envoyé, 12 mois sans réponse de votre part, 24 mois après le dernier échange.",
    );
    expect(text).toContain(
      "Vos droits : accès, rectification, effacement et limitation du traitement.",
    );
    expect(text).toContain("Vous pouvez vous opposer à tout moment, sans motif");
    expect(text).toContain("cnil.fr/plaintes");
    expect(text).toContain("https://immojudis.com/privacy");
    expect(text).toContain("Ne plus être contacté (un clic) : https://immojudis.com/api/");
    expect(text).not.toContain("outil de recherche automatisé");
  });

  it("nomme le prestataire d'IA fourni par la configuration, pas un texte figé", () => {
    const text = informationAgentLegalFooterLines({
      ...footer,
      aiProvider: { id: "autre", name: "Autre Prestataire", country: "France" },
    }).join("\n");
    expect(text).toContain("Autre Prestataire (France), outil d’IA");
    expect(text).not.toContain("Replicate");
  });

  it("ajoute la mention de la recherche automatique quand l'adresse a été retrouvée par l'agent", () => {
    const sections = informationAgentLegalFooterSections({ ...footer, automatedSearch: true });
    expect(sections.find((section) => section.label === "Recherche de l’adresse :")?.text).toBe(
      "Cette adresse a été retrouvée par un outil de recherche automatisé d’Immojudis, qui consulte ponctuellement des pages publiques sans en conserver de copie. Ce message a été relu et validé par un membre de l’équipe avant envoi.",
    );
  });
});
