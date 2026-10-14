import { describe, expect, it } from "vitest";
import {
  formatInformationAgentOriginDate,
  informationAgentControllerIdentity,
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
      "Votre adresse professionnelle figure dans une autre annonce publique de vente qui vous mentionne comme interlocuteur, sur Licitor (https://www.licitor.com/annonce/2) ; Immojudis l’a reprise de cette annonce le 14/10/2026.",
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
    [
      "annuaire des avocats du CNB",
      "https://www.cnb.avocat.fr/fiche/1",
      "Votre adresse professionnelle figure sur votre fiche publique de l’annuaire des avocats du Conseil national des barreaux (https://www.cnb.avocat.fr/fiche/1), consultée le 14/10/2026.",
    ],
    [
      "annuaire du barreau de Bordeaux",
      "https://www.barreau-bordeaux.com/avocat/jean-dupont/",
      "Votre adresse professionnelle figure sur votre fiche publique de l’annuaire du barreau de Bordeaux (https://www.barreau-bordeaux.com/avocat/jean-dupont/), consultée le 14/10/2026.",
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

  it("un nom d'annuaire hors de la liste fermée n'est jamais interpolé", () => {
    const origin = informationAgentAddressOrigin({
      sourceKind: "official_directory",
      directoryName: "annuaire inventé <b>",
      sourceUrl: "https://annuaire.example.test/x",
      observedAt: OBSERVED_AT,
      observedBy: "agent",
    });
    expect(origin.text).toBe(
      "Votre adresse professionnelle figure sur votre fiche publique de l’annuaire officiel de votre profession (https://annuaire.example.test/x), consultée le 14/10/2026.",
    );
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
      "Votre adresse professionnelle figure sur le site de votre cabinet ou de votre étude (https://cabinet-dupont.example.test/contact), consulté le 14/10/2026.",
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
    expect(text).toContain(
      "Base : intérêt légitime à publier des informations exactes sur les ventes aux enchères (art. 6.1.f RGPD). Nous vous écrivons au plus une fois par période de 30 jours, toutes ventes confondues, et sans relance.",
    );
    expect(text).toContain(
      "Responsable de traitement : Immojudis SAS, 1 rue de la Paix, 75002 Paris — contact@immojudis.test.",
    );
    expect(text).toContain(
      "Vos données : votre nom, votre fonction, votre adresse professionnelle et nos échanges. Origine : Origine X.",
    );
    expect(text).toContain("Destinataires : l’équipe Immojudis et ses prestataires");
    expect(text).toContain("Resend (envoi et réception des courriels)");
    expect(text).toContain("GitHub (exécution des traitements automatisés)");
    expect(text).toContain("Replicate (États-Unis), outil d’IA");
    expect(text).toContain(
      "Ces prestataires peuvent traiter des données hors de l’Union européenne, notamment aux États-Unis. Pour savoir quelle garantie s’applique à chacun, ou en obtenir une copie, écrivez à contact@immojudis.test ; aucun compte n’est nécessaire.",
    );
    // Aucun mécanisme de transfert non vérifié.
    expect(text).not.toMatch(
      /clauses contractuelles|décision d’adéquation|Data Privacy Framework/i,
    );
    expect(text).toContain(
      "Conservation : 12 mois si vous ne répondez pas ; 24 mois après le dernier échange si vous répondez.",
    );
    expect(text).not.toContain("30 jours si aucun message");
    expect(text).toContain(
      "Vos droits : accès, rectification, effacement et limitation du traitement. Pour les exercer sans créer de compte, écrivez à contact@immojudis.test ou répondre à ce message.".replace(
        "répondre",
        "répondez",
      ),
    );
    expect(text).toContain("saisir la CNIL d’une réclamation (cnil.fr/plaintes)");
    expect(text).toContain(
      "Opposition : Vous pouvez vous opposer à tout moment, sans motif, à ce que nous vous contactions : utilisez le lien « Ne plus être contacté » ci-dessous ou répondez à ce message. Nous ne vous solliciterons plus, sur aucun de nos canaux. Les données qui ne servent qu’à vous contacter sont supprimées ; les échanges déjà intervenus sont conservés jusqu’à la fin de leur durée normale (12 ou 24 mois), puis supprimés. Seule l’information strictement nécessaire pour ne plus vous solliciter (adresse, identité professionnelle, date de l’opposition) est conservée au-delà, à cette seule fin.",
    );
    expect(text).toContain("https://immojudis.com/privacy");
    expect(text).toContain("Ne plus être contacté (un clic) : https://immojudis.com/api/");
    expect(text).not.toContain("retrouvée automatiquement");
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
    const sectionOf = (extra: Partial<InformationAgentLegalFooter>) =>
      informationAgentLegalFooterSections({ ...footer, automatedSearch: true, ...extra }).find(
        (section) => section.label === "Recherche de l’adresse :",
      )?.text;
    expect(sectionOf({})).toBe(
      "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une page publique (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.",
    );
    expect(sectionOf({ automatedSearchSource: "firm_website" })).toBe(
      "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une page publique (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.",
    );
    // Autre annonce : la source est une annonce déjà enregistrée, pas une page consultée.
    expect(sectionOf({ automatedSearchSource: "other_listing" })).toBe(
      "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une annonce publique déjà enregistrée par Immojudis (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.",
    );
  });

  it("n'ajoute aucune mention quand l'adresse vient de l'annonce de la vente ou d'un administrateur", () => {
    for (const sourceKind of ["sale_listing", "admin_entry"] as const) {
      const origin = informationAgentAddressOrigin({
        sourceKind,
        sourceUrl: "https://www.licitor.com/annonce/1",
        observedAt: OBSERVED_AT,
        observedBy: sourceKind === "admin_entry" ? "admin" : "agent",
      });
      expect(origin.automated).toBe(false);
      expect(origin.searchSource).toBeUndefined();
    }
    const found = informationAgentAddressOrigin({
      sourceKind: "other_listing",
      sourceUrl: "https://www.licitor.com/annonce/2",
      observedAt: OBSERVED_AT,
      observedBy: "agent",
    });
    expect(found).toMatchObject({ automated: true, searchSource: "other_listing" });
  });

  it("site du cabinet : libellé nominatif, ou celui de l'adresse du cabinet pour une adresse générique", () => {
    const base = {
      sourceKind: "firm_website" as const,
      sourceUrl: "https://www.cabinet-dupont.test/contact",
      observedAt: OBSERVED_AT,
      observedBy: "agent" as const,
    };
    expect(informationAgentAddressOrigin({ ...base, matchRule: "firm_site_name" }).text).toBe(
      "Votre adresse professionnelle figure sur le site de votre cabinet ou de votre étude (https://www.cabinet-dupont.test/contact), consulté le 14/10/2026.",
    );
    expect(informationAgentAddressOrigin(base).text).toBe(
      "Votre adresse professionnelle figure sur le site de votre cabinet ou de votre étude (https://www.cabinet-dupont.test/contact), consulté le 14/10/2026.",
    );
    const generic = informationAgentAddressOrigin({ ...base, matchRule: "firm_site_generic" });
    expect(generic.text).toBe(
      "L’adresse de contact de votre cabinet ou de votre étude figure sur son site (https://www.cabinet-dupont.test/contact), consulté le 14/10/2026.",
    );
    expect(generic.automated).toBe(true);
    expect(generic.searchSource).toBe("firm_website");
  });

  it("refuse un pied sans adresse de contact : l'identité du responsable l'exige", () => {
    expect(
      informationAgentControllerIdentity({
        NEXT_PUBLIC_LEGAL_ENTITY_NAME: "Immojudis SAS",
        NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de la Paix",
      }),
    ).toBeNull();
  });
});
