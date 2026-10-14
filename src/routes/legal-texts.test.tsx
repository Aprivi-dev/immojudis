// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYSIS_OFFER_LABEL, ANALYSIS_TRIAL_DAYS } from "@/lib/analysis-offer";
import { LEGAL_DOCUMENTS } from "@/lib/legal-documents";
import { PAST_DUE_GRACE_DAYS, PLAN_LIMITS } from "@/lib/plans";
import { TermsPage } from "./conditions-generales";
import { PrivacyPage } from "./privacy";

function pageText(node: React.ReactElement): string {
  const { container } = render(node);
  return (container.textContent ?? "").replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", "contact@immojudis.example");
  vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("conditions générales", () => {
  it("annoncent leur version et un abonnement à durée indéterminée résiliable à tout moment", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(`Version ${LEGAL_DOCUMENTS.terms.version}`);
    expect(text).toContain(
      "L’abonnement est conclu pour une durée indéterminée et facturé chaque mois. Vous pouvez le résilier à tout moment, sans frais ni préavis ; la résiliation prend effet à la fin de la période mensuelle en cours.",
    );
    expect(text).not.toContain("reconduit chaque mois");
  });

  it("annoncent l'email de confirmation de la résiliation", () => {
    expect(pageText(<TermsPage />)).toContain(
      "Nous vous confirmons par email la réception de votre demande et la date de fin du contrat.",
    );
  });

  it("adressent le formulaire de rétractation à l'éditeur, avec ses coordonnées", () => {
    vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_NAME", "Immojudis SAS");
    vi.stubEnv("NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS", "1 rue de Paris, 75001 Paris");
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "À l’attention de Immojudis SAS, 1 rue de Paris, 75001 Paris, contact@immojudis.example :",
    );
    expect(text).not.toContain("À l’attention de l’éditeur Immojudis");
    expect(text).toContain(
      "Pendant l’essai gratuit, aucun montant n’est dû en cas de rétractation.",
    );
  });

  it("affichent le prix configurable et l'essai gratuit s'il est proposé", () => {
    expect(pageText(<TermsPage />)).toContain(
      `Prix de l’abonnement Analyse : ${DEFAULT_ANALYSIS_OFFER_LABEL}, précédé d’un essai gratuit de ${ANALYSIS_TRIAL_DAYS} jours lorsque celui-ci est proposé`,
    );
    cleanup();
    // Only a label stating the billed price passes the build (scripts/verify-required-env.mjs).
    vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "29 € / mois");
    expect(pageText(<TermsPage />)).toContain("Prix de l’abonnement Analyse : 29 € / mois");
  });

  it("décrivent un seul chemin de résiliation, aligné sur le bouton réel du compte", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Vous pouvez résilier à tout moment, gratuitement, depuis la page Mon compte, bouton « Résilier mon abonnement », qui ouvre directement le formulaire de résiliation du portail de paiement sécurisé Stripe. La date de fin d’accès est affichée avant confirmation.",
    );
    expect(text).not.toContain("Gérer mon abonnement");
    expect(text).not.toContain("page Offres");
  });

  it("énoncent le délai de grâce réel en cas d'impayé", () => {
    expect(PAST_DUE_GRACE_DAYS).toBe(7);
    expect(pageText(<TermsPage />)).toContain(
      `En cas d’échec de paiement, Stripe retente le prélèvement. Votre accès Analyse reste ouvert ${PAST_DUE_GRACE_DAYS} jours à compter de la fin de la période payée pour vous permettre de mettre à jour votre moyen de paiement ; la mensualité reste due. Passé ce délai sans paiement, l’accès est suspendu. Votre compte Découverte et vos données restent accessibles.`,
    );
  });

  it("rappellent la garantie légale de conformité, y compris pour un service continu", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Vous bénéficiez de la garantie légale de conformité des contenus et services numériques (articles L. 224-25-12 à L. 224-25-26 du code de la consommation).",
    );
    expect(text).toContain(
      "Pour un service fourni de manière continue, nous répondons des défauts de conformité qui apparaissent pendant toute la durée de l’abonnement.",
    );
  });

  it("emploient « Analyse » et « enchère plafond »", () => {
    const text = pageText(<TermsPage />);
    expect(text).not.toMatch(/Premium|mise plafond/i);
    expect(text).toContain("enchère plafond");
  });
});

describe("conditions générales : 3 déblocages par mois", () => {
  const n = PLAN_LIMITS.decouverte.monthlyUnlocks;

  it("définissent le déblocage : une vente, cinq éléments quand elle les comporte, le reste à Analyse", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain("Découverte est gratuite, sans limite de durée et sans carte bancaire.");
    expect(text).toContain(`chaque mois civil, ${n} déblocages`);
    expect(text).toContain(
      "Un déblocage ouvre, pour une vente de votre choix, les éléments suivants de l’offre Analyse lorsque cette vente les comporte : l’enchère plafond chiffrée, la lecture des pièces, l’historique de la vente, les statistiques du tribunal compétent pour cette vente et les pièces du dossier.",
    );
    expect(text).toContain(
      "Les autres fonctions de l’offre Analyse, notamment l’export PDF ou CSV, les rapports enregistrés, le budget travaux, les alertes avancées et la mise en relation avec un avocat référencé, restent réservées à cette offre.",
    );
    // Jamais « réservé » pour un élément que le compte reçoit.
    const reserved = text.slice(text.indexOf("Les autres fonctions de l’offre Analyse"));
    const reservedSentence = reserved.slice(0, reserved.indexOf("restent réservées"));
    for (const received of [
      "enchère plafond",
      "lecture des pièces",
      "historique",
      "statistiques",
      "pièces du dossier",
    ]) {
      expect(reservedSentence).not.toContain(received);
    }
  });

  it("disent quand le déblocage est consommé, non restitué, non reporté, et quand le compteur repart", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Le déblocage est consommé quand vous le confirmez, après affichage du nombre restant",
    );
    expect(text).toContain(
      "il n’est pas consommé en cas d’erreur technique, ni si la vente est déjà débloquée",
    );
    expect(text).toContain(
      "Il n’est pas restitué si la vente est ensuite reportée ou adjugée, ni si elle est retirée par la juridiction ou la source. Si Immojudis retire elle-même la vente pour une raison qui lui est imputable, le déblocage est restitué sur simple demande depuis Mes droits ou à l’adresse de contact.",
    );
    expect(text).toContain("Les déblocages non utilisés ne sont pas reportés.");
    expect(text).toContain(
      `Le compteur est remis à ${n} le 1er de chaque mois à 00 h 00, heure de Paris.`,
    );
    expect(text).toContain(
      "tant qu’elle est en ligne sur Immojudis, dans la limite de 24 mois après le déblocage, et tant que votre compte existe",
    );
  });

  it("disent le sort des ventes débloquées après un abonnement Analyse", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Pendant un abonnement Analyse, essai compris, aucun déblocage n’est consommé. À la fin de l’abonnement, le compte revient à Découverte : les ventes que vous aviez déjà débloquées restent accessibles ; les autres ventes consultées pendant l’abonnement redeviennent soumises aux déblocages.",
    );
  });

  it("limitent la clause de modification aux déblocages, avec trente jours de préavis", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Immojudis peut modifier ou supprimer les déblocages mensuels pour l’avenir, en vous prévenant au moins 30 jours à l’avance par un message dans l’application ou à l’adresse email de votre compte. Les ventes que vous avez déjà débloquées restent accessibles dans les conditions ci-dessus, et les déblocages déjà consommés ne sont pas affectés. Si la modification ne vous convient pas, vous pouvez fermer votre compte gratuitement depuis Mes droits.",
    );
    // Les autres avantages de Découverte (favoris, alerte) ne sont plus modifiables par cette clause.
    expect(text).not.toContain("les avantages de l’offre Découverte");
  });

  it("rendent les déblocages personnels (article 9) sans parler d’analyses gratuites", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Les déblocages de ventes sont personnels : ils ne se partagent ni ne se transmettent.",
    );
    expect(text).toContain(
      "le contournement des quotas, notamment la création de plusieurs comptes pour multiplier les déblocages",
    );
    expect(text).not.toMatch(/analyses? (complètes? )?gratuites?|analyse offerte/i);
  });

  it("ne réécrivent à la main ni le chiffre des déblocages ni leur nom dans les textes publics", () => {
    for (const file of [
      "src/routes/conditions-generales.tsx",
      "src/app/offres/offers-page.tsx",
      "src/lib/offer-comparison.ts",
      "src/components/sale-detail/SaleUnlockPanel.tsx",
      "src/components/SalePublicPreview.tsx",
      "src/lib/sale-unlocks.ts",
    ]) {
      // Comments name the feature in prose; only the strings the page renders matter.
      const source = readFileSync(resolve(file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/(?<![\w$])(3|trois) (déblocages|ventes par mois)/i);
      expect(source, file).not.toMatch(/analyses? (complètes? )?gratuites?|Analyse offerte/i);
    }
  });
});

describe("politique de confidentialité", () => {
  it("décrit le traitement des déblocages : base contractuelle et conservation de 24 mois au plus", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Déblocages mensuels de ventes (offre Découverte)");
    expect(text).toContain("Identifiant de compte, vente débloquée, date du déblocage");
    expect(text).toContain(
      "Exécution du contrat : appliquer l’avantage et sa limite prévus par les conditions générales",
    );
    expect(text).toContain(
      "24 mois au plus après le déblocage, et suppression avec le compte. Si la vente est supprimée du site, le lien avec la vente est coupé : seuls l’identifiant de compte et la date du déblocage sont gardés, jusqu’à la fin du mois civil en cours (effacement lors de la purge hebdomadaire qui suit), pour que le compteur du mois ne soit pas remis à zéro.",
    );
  });

  it("annonce sa version et écrit Immojudis", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(`Version ${LEGAL_DOCUMENTS.privacy.version}`);
    expect(text).not.toContain("ImmoJudis");
    expect(text).not.toMatch(/Premium/);
  });

  it("décrit le traitement des annonces publiques et la cartographie", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Annonces de ventes et pièces publiques");
    expect(text).toContain("noms remplacés par leur rôle");
    expect(text).toContain("Intérêt légitime à informer le public");
    expect(text).toContain("opposition et demande de retrait par email, sans compte");
    expect(text).toContain("Cartographie et géocodage (Mapbox, IGN)");
  });

  it("déclare le repli de géocodage et les cartes cadastrales de l'IGN, avec l'adresse IP", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "l’adresse que vous saisissez est transmise à l’API Adresse de la Base Adresse Nationale (service public exploité par l’IGN), avec votre adresse IP.",
    );
    expect(text).toContain(
      "Les cartes cadastrales sont chargées depuis la Géoplateforme de l’IGN (data.geopf.fr), qui reçoit votre adresse IP et la zone affichée.",
    );
    expect(text).toContain("l’Institut national de l’information géographique et forestière (IGN");
  });

  it("décrit l'annuaire d'avocats et l'ouverture de l'offre Analyse comme des traitements distincts", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Annuaire d’avocats");
    expect(text).toContain("Licence Ouverte 2.0");
    expect(text).toContain("opposition et rectification par email, sans compte");
    expect(text).toContain("Prévenir de l’ouverture de l’offre Analyse");
    expect(text).toContain(
      "Jusqu’à l’envoi de l’email d’ouverture ou au retrait, puis 30 jours ; 12 mois au plus sans ouverture",
    );
  });

  it("aligne la mise en relation sur le code : avocat désigné et conservation avec la vente", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Si vous ne choisissez pas d’avocat, Immojudis en désigne un parmi les avocats bénéficiant d’une mise en avant payante",
    );
    expect(text).toContain(
      "Cet avocat traite ensuite votre demande sous sa propre responsabilité.",
    );
    expect(text).toContain("Supprimée avec la vente concernée à l’échéance de conservation");
    expect(text).not.toContain("message, dossier concerné");
  });

  it("annonce la conservation du formulaire de contact : 12 mois, puis suppression", () => {
    expect(pageText(<PrivacyPage />)).toContain(
      "12 mois après le dernier échange, puis suppression ; en cas de litige ou de réclamation, le temps de la procédure puis, en archive à accès restreint, 5 ans au plus",
    );
  });

  it("permet à une personne citée de demander retrait ou rectification sans compte", () => {
    expect(pageText(<PrivacyPage />)).toContain(
      "Si vous êtes cité dans une annonce, vous pouvez demander la rectification ou le retrait à contact@immojudis.example, sans créer de compte.",
    );
  });

  it("liste Mapbox, le prestataire d'IA et le rapport d'erreurs parmi les destinataires", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Mapbox (cartes, vignettes et géocodage)");
    expect(text).toContain("le prestataire d’IA utilisé pour lire les annonces et les pièces");
    expect(text).toContain("Replicate");
    expect(text).toContain("le service de rapport d’erreurs lorsqu’il est configuré");
  });

  it("décrit la mesure d'audience, son opposition et une conservation de 25 mois au plus", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Nous mesurons la fréquentation avec Vercel Analytics et Speed Insights, sans cookie et sans suivi entre sites, et des événements de parcours agrégés, sans identifiant de personne.",
    );
    expect(text).not.toContain("parcours anonymes");
    expect(text).toContain("Les données ne servent qu’à des statistiques de notre service.");
    expect(text).toContain(
      "Vous pouvez vous opposer à la mesure d’audience depuis cette page (votre choix est mémorisé dans ce navigateur) ou en nous écrivant à contact@immojudis.example.",
    );
    const months = [...text.matchAll(/(\d+) mois au plus/g)].map((match) => Number(match[1]));
    expect(months.length).toBeGreaterThan(0);
    for (const value of months) expect(value).toBeLessThanOrEqual(25);
  });

  it("aligne la base légale de l'enquête dossier sur le registre et ne parle plus de prospection", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Intérêt légitime à fiabiliser le catalogue auprès des professionnels contactés ; les échanges sont déclenchés et chaque message envoyé est validé par un administrateur. Les adresses ayant exercé leur opposition sont conservées pour la respecter.",
    );
    // L'email du demandeur n'est jamais communiqué (share_requester_email reste à false).
    expect(text).not.toContain("consentement pour la communication de l’email de réponse");
    expect(text).not.toContain("service professionnel");
    expect(text).toContain("aucune sollicitation commerciale");
  });

  it("décrit l'IA du message d'enquête comme le fait le message lui-même", () => {
    expect(pageText(<PrivacyPage />)).toContain(
      "Le message précise qu’une IA aide à lire et classer les réponses et que l’équipe vérifie les informations avant toute mise à jour de la fiche",
    );
  });

  it("propose l'interrupteur d'opposition à la mesure d'audience", () => {
    const { getByRole } = render(<PrivacyPage />);
    const toggle = getByRole("switch", {
      name: "Je m’oppose à la mesure d’audience sur ce navigateur",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });
});
