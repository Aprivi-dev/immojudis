// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ANALYSIS_OFFER_LABEL } from "@/lib/analysis-offer";
import {
  FREE_UNLOCK_EFFECTIVE_DATE,
  FULL_SALE_UNLOCK_EFFECTIVE_DATE,
  LEGAL_DOCUMENTS,
} from "@/lib/legal-documents";
import { PREVIOUS_LEGAL_DOCUMENTS } from "@/lib/legal-documents-previous";
import { PAST_DUE_GRACE_DAYS, PLAN_LIMITS } from "@/lib/plans";
import { FREE_SALE_UNLOCKS } from "@/lib/sale-unlocks";
import { TermsPage } from "./conditions-generales";
import { LegalPage } from "./legal";
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
    expect(text).toContain(
      "Le prix est prélevé automatiquement à la souscription, puis chaque mois à la même date, jusqu’à la résiliation.",
    );
    // Contrat à durée indéterminée : jamais de « reconduction », qui le ferait lire comme un contrat à
    // durée déterminée reconduit tacitement (articles L215-1 et suivants du code de la consommation).
    expect(text).not.toContain("reconduit");
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
      "L’offre Découverte est sans paiement : aucun montant n’est dû, et vous pouvez demander la fermeture de votre compte à tout moment, gratuitement, depuis Mes droits. Le droit de rétractation ci-dessous s’applique à l’abonnement Analyse : le délai de 14 jours court à compter de la conclusion de l’abonnement.",
    );
  });

  it("affichent le prix configurable, sans essai dans l'abonnement", () => {
    expect(pageText(<TermsPage />)).toContain(
      `Prix de l’abonnement Analyse : ${DEFAULT_ANALYSIS_OFFER_LABEL}. Ce prix est un prix final : TVA non applicable, art. 293 B du CGI.`,
    );
    cleanup();
    // Only a label stating the billed price (scripts/verify-required-env.mjs) and « TTC »
    // (resolveAnalysisOfferLabel) is shown; one without « TTC » gives way to the approved label.
    vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "59 € TTC par mois");
    expect(pageText(<TermsPage />)).toContain("Prix de l’abonnement Analyse : 59 € TTC par mois");
    cleanup();
    vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "59 € / mois");
    expect(pageText(<TermsPage />)).toContain(
      `Prix de l’abonnement Analyse : ${DEFAULT_ANALYSIS_OFFER_LABEL}`,
    );
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

describe("conditions générales : classement, référencement et mise en avant", () => {
  it("résument le classement par défaut, la publicité des avocats et renvoient à la page publique", () => {
    const { container } = render(<TermsPage />);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain("10. Classement, référencement et mise en avant");
    expect(text).toContain(
      "Par défaut, les annonces dont la position sur la carte est connue passent avant les autres. Elles sont ensuite classées selon la quantité d’informations renseignées dans leur fiche, puis par date de vente la plus proche. Aucune rémunération ne peut améliorer le rang d’une annonce ni lui valoir un repère (« Annonce bien renseignée », « Pépite »).",
    );
    expect(text).toContain(
      "Dans l’annuaire des avocats, les cabinets qui rémunèrent Immojudis, ou bénéficient d’une période d’essai de cette offre de mise en avant, sont affichés en premier dans une section distincte, signalés « Publicité · Sponsorisé » ; ils ne sont ni recommandés ni notés.",
    );
    expect(text).toContain(
      "Un encart d’un cabinet d’avocats, signalé de la même façon, peut aussi apparaître dans la liste des ventes pour une zone géographique ; il ne modifie pas l’ordre des annonces et n’est ni une recommandation, ni une notation, ni une garantie de résultat.",
    );
    expect(text).toContain(
      "Une vente passée, annulée ou retirée n’est plus affichée dès que cette information est connue d’Immojudis.",
    );
    const link = [...container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Comment sont classées les annonces ?",
    );
    expect(link?.getAttribute("href")).toBe("/classement-des-annonces");
    // Les sections suivantes sont renumérotées sans trou.
    expect(text).toContain("11. Données personnelles");
    expect(text).toContain("12. Réclamations, médiation et droit applicable");
  });

  it("portent la version 2026-11-15.2 (le déblocage ouvre toute l'offre Analyse sur la vente), ancrée par l'empreinte de leur source ; les 2026-11-15.1, 2026-11-10.1 et 2026-10-26.1 sont archivées", () => {
    expect(LEGAL_DOCUMENTS.terms.version).toBe("2026-11-15.2");
    expect(PREVIOUS_LEGAL_DOCUMENTS.terms.earlier.map((earlier) => earlier.version)).toEqual([
      "2026-11-15.1",
      "2026-11-10.1",
      "2026-10-26.1",
    ]);
    expect(PREVIOUS_LEGAL_DOCUMENTS.terms.earlier[0].applicableUntil).toBe(
      FULL_SALE_UNLOCK_EFFECTIVE_DATE,
    );
    expect(PREVIOUS_LEGAL_DOCUMENTS.terms.earlier[1].applicableUntil).toBe(
      FREE_UNLOCK_EFFECTIVE_DATE,
    );
  });

  // Décision du propriétaire du 15/11/2026 : l'article 2 (offre Découverte) et l'article 13
  // s'appliquent aux comptes existants dès la mise en ligne, sans ce préavis (legal-documents.ts).
  it("gardent le préavis de 30 jours de l'article 14 pour les autres stipulations : comptes existants soumis au reste de la version au moins 30 jours après le 1er novembre 2026, dernier jour d'envoi de l'information", () => {
    const mois = [
      "janvier",
      "février",
      "mars",
      "avril",
      "mai",
      "juin",
      "juillet",
      "août",
      "septembre",
      "octobre",
      "novembre",
      "décembre",
    ];
    expect(LEGAL_DOCUMENTS.terms.effectiveDate).toBe("1er décembre 2026");
    const [jour, nom, annee] = LEGAL_DOCUMENTS.terms.effectiveDate.split(" ");
    const entreeEnVigueur = Date.UTC(Number(annee), mois.indexOf(nom), Number.parseInt(jour, 10));
    const informationAuPlusTard = Date.UTC(2026, 10, 1);
    expect(entreeEnVigueur - informationAuPlusTard).toBeGreaterThanOrEqual(30 * 24 * 3600 * 1000);
  });

  it("précisent dans l'en-tête qui est soumis à quelle version, et où obtenir la précédente", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      `Version 2026-11-15.2, applicable dès l’inscription pour les comptes créés à partir de sa mise en ligne. Pour les comptes existants, l’article 2, pour ce qui concerne l’offre Découverte et son déblocage, s’applique à compter du ${FULL_SALE_UNLOCK_EFFECTIVE_DATE}, et l’article 13 à compter du ${FREE_UNLOCK_EFFECTIVE_DATE} ; les autres stipulations s’appliquent à compter du 1er décembre 2026. Jusqu’à cette date, la version précédente (2026-10-25.1) reste applicable aux comptes existants pour ces autres stipulations ; elle est communiquée sur demande à contact@immojudis.example.`,
    );
    expect(PREVIOUS_LEGAL_DOCUMENTS.terms.applicableUntil).toBe(
      LEGAL_DOCUMENTS.terms.effectiveDate,
    );
  });

  it("annoncent le repère « Pépite » : visible par tous, montant et détail réservés à Analyse ou à un déblocage (article 2)", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Lorsqu’il est attribué à une vente, le repère « Pépite » est visible par tous. Il est calculé automatiquement par Immojudis, à partir de critères publics décrits sur la page Comment repérons-nous les pépites ?. Le montant de l’enchère plafond ou de l’offre plafond estimée, selon la vente, et le détail du calcul sont réservés à l’offre Analyse ou à un déblocage, dans les conditions du présent article.",
    );
    expect(text).toContain("enchère plafond ou offre plafond selon la vente");
    expect(text).toContain(
      "l’enchère plafond ou l’offre plafond chiffrée, selon la vente, l’estimation détaillée",
    );
  });

  it("rangent la Pépite parmi les aides à la lecture, sans conseil ni garantie (article 8)", () => {
    expect(pageText(<TermsPage />)).toContain(
      "Le repère « Pépite », les enchères et offres plafond estimées et les prix probables sont des aides à la lecture calculées automatiquement à partir des données disponibles : ce sont des hypothèses et non des résultats. Ils ne constituent ni un conseil, ni une recommandation d’acheter ou d’enchérir, et ne garantissent ni un prix, ni un rendement, ni une adjudication, ni un prix de revente.",
    );
  });

  it("disent qu'aucune rémunération n'influence la Pépite et que les encarts sponsorisés sont séparés (article 10)", () => {
    const { container } = render(<TermsPage />);
    const text = (container.textContent ?? "").replace(/\s+/g, " ");
    expect(text).toContain(
      "Le repère « Pépite » est attribué par un calcul automatique, à partir de critères publics décrits sur la page Comment repérons-nous les pépites ?. Aucune rémunération ne peut obtenir ou améliorer une Pépite : ni les cabinets d’avocats qui achètent une mise en avant, ni les organisateurs, vendeurs ou professionnels qui publient des annonces. Le repère ne modifie pas l’ordre des annonces. Les encarts sponsorisés des cabinets d’avocats sont séparés des annonces et sans lien avec ce repère.",
    );
    const links = [...container.querySelectorAll("a")].filter(
      (anchor) => anchor.textContent === "Comment repérons-nous les pépites ?",
    );
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const link of links) expect(link.getAttribute("href")).toBe("/methode-pepites");
  });

  it("la politique de confidentialité est en version 2026-11-15.1 (déblocage de vente, fin de l'essai) ; les 2026-11-14.1, 2026-11-01.3, 2026-11-01.2, 2026-11-01.1, 2026-10-31.1, 2026-10-26.1 et 2026-10-25.1 sont archivées", () => {
    expect(LEGAL_DOCUMENTS.privacy.version).toBe("2026-11-15.1");
    // La version garde la date de rédaction ; l'effet est porté à la mise en ligne prévue, la même
    // que celle des CGU 2026-11-15.1.
    expect(LEGAL_DOCUMENTS.privacy.effectiveDate).toBe(FREE_UNLOCK_EFFECTIVE_DATE);
    expect(PREVIOUS_LEGAL_DOCUMENTS.privacy.version).toBe("2026-11-14.1");
    expect(PREVIOUS_LEGAL_DOCUMENTS.privacy.applicableUntil).toBe(
      LEGAL_DOCUMENTS.privacy.effectiveDate,
    );
    expect(PREVIOUS_LEGAL_DOCUMENTS.privacy.earlier.map((item) => item.version)).toEqual([
      "2026-11-01.3",
      "2026-11-01.2",
      "2026-11-01.1",
      "2026-10-31.1",
      "2026-10-26.1",
      "2026-10-25.1",
    ]);
  });
});

describe("conditions générales : fin de l'essai gratuit à l'inscription (15/11/2026)", () => {
  it("remplacent l'article 13 par la fin de l'essai : retour à Découverte sans frais ni perte de données", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain("13. Fin de l’essai gratuit à l’inscription");
    expect(text).toContain(
      `L’essai gratuit de l’offre Analyse à l’inscription n’est plus proposé depuis le ${FREE_UNLOCK_EFFECTIVE_DATE}, date d’entrée en vigueur de cet article. Les comptes qui en bénéficiaient à cette date sont revenus à l’offre Découverte, sans frais, sans paiement automatique et sans suppression des données. Leurs données (favoris, alertes, rapports enregistrés) restent conservées dans les conditions de la politique de confidentialité.`,
    );
    expect(text).not.toContain("13. Essai gratuit à l’inscription");
    expect(text).not.toContain("13. Offre de lancement");
  });

  it("ne décrivent plus d'essai proposé ni ne renvoient à « l'essai gratuit de l'article 13 »", () => {
    const text = pageText(<TermsPage />);
    for (const gone of [
      "l’essai gratuit de l’article 13",
      "l’essai gratuit est proposé",
      "sauf pour l’essai gratuit",
      "obtenir plusieurs fois l’essai gratuit",
      "pendant l’essai gratuit",
      "À la fin de l’abonnement ou de l’essai",
      "Cet article est spécial à l’essai",
    ]) {
      expect(text).not.toContain(gone);
    }
    // « essai » ne reste que dans l'article 13 (fin de l'essai), dans « L'abonnement ne comprend pas
    // de période d'essai » et dans la période d'essai de la mise en avant des avocats (article 10).
    const article13 = text.slice(
      text.indexOf("13. Fin de l’essai"),
      text.indexOf("14. Modification"),
    );
    const rest = text.replace(article13, "");
    expect(rest.match(/\bessais?\b/gi)).toEqual(["essai", "essai"]);
    expect(rest).toContain("L’abonnement ne comprend pas de période d’essai.");
    expect(rest).toContain("bénéficient d’une période d’essai de cette offre de mise en avant");
  });

  it("n'affirment pas que les titulaires de compte ont été prévenus 30 jours avant ce changement", () => {
    const text = pageText(<TermsPage />);
    expect(text).not.toMatch(/(ont été|avez été) (prévenus?|informés?)/);
  });

  it("gardent l'article 14 : modification des conditions avec 30 jours de préavis, sans exception pour l'essai", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain("14. Modification des conditions");
    expect(text).toContain(
      "au moins 30 jours avant l’entrée en vigueur, sauf obligation légale ou impératif de sécurité. Une modification n’est jamais appliquée à un abonnement en cours sans l’accord du client.",
    );
  });

  it("ne mettent pas d'essai dans l'abonnement", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "L’abonnement ne comprend pas de période d’essai. Le tarif applicable est présenté avant la confirmation de la souscription.",
    );
    expect(text).not.toContain("nécessite l’enregistrement d’une carte bancaire");
    expect(text).not.toContain("la fin de l’essai et la date du premier prélèvement");
    expect(text).not.toContain("Une résiliation pendant l’essai évite le premier prélèvement");
  });

  it("tirent le nombre de favoris du code, pas du texte", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(`${PLAN_LIMITS.decouverte.favoriteSales} favoris au maximum`);
    expect(text).not.toContain("trois favoris");
  });

  it("indiquent la franchise de TVA à côté du prix, sans dire que la souscription n'est pas ouverte", () => {
    expect(pageText(<TermsPage />)).not.toContain("pas encore ouverte");
    expect(pageText(<TermsPage />)).toContain(
      `Prix de l’abonnement Analyse : ${DEFAULT_ANALYSIS_OFFER_LABEL}. Ce prix est un prix final : TVA non applicable, art. 293 B du CGI.`,
    );
  });

  it("disent que les rappels et avertissements sont indicatifs (article 8)", () => {
    expect(pageText(<TermsPage />)).toContain(
      "Les rappels et avertissements sont indicatifs. Ils ne dispensent pas de vérifier la date et le statut de la vente auprès de l’avocat poursuivant.",
    );
  });
});

describe("conditions générales : un déblocage de vente en tout", () => {
  it("définissent le déblocage : une vente, toute l'offre Analyse propre à cette vente, le reste à Analyse", () => {
    const text = pageText(<TermsPage />);
    expect(FREE_SALE_UNLOCKS).toBe(1);
    expect(text).toContain("Découverte est gratuite, sans limite de durée et sans carte bancaire.");
    expect(text).toContain(
      `une alerte avec un email hebdomadaire et ${FREE_SALE_UNLOCKS} déblocage de vente en tout, qui ne se renouvelle pas chaque mois.`,
    );
    expect(text).toContain(
      "Un déblocage ouvre, pour une vente de votre choix, l’ensemble des éléments de l’offre Analyse propres à cette vente, lorsqu’elle les comporte : l’enchère plafond ou l’offre plafond chiffrée, selon la vente, l’estimation détaillée (valeur estimée et fourchette) et les ventes comparables, le budget travaux détaillé, les pièces du dossier et leur lecture, l’historique de la vente, les statistiques du tribunal compétent pour cette vente, l’urbanisme et le cadastre, le dossier du terrain, l’analyse du quartier, la prévision d’audience, le rapport enregistré et le rapport PDF de cette vente.",
    );
    expect(text).toContain(
      `Restent réservés à l’offre Analyse : ces éléments sur les autres ventes, l’export CSV, les alertes avancées et quotidiennes, les favoris au-delà de ${PLAN_LIMITS.decouverte.favoriteSales}, les statistiques des autres tribunaux, le partage d’un rapport par lien et la mise en relation avec un avocat référencé.`,
    );
    // Jamais « réservé » pour un élément que le déblocage ouvre.
    const reserved = text.slice(text.indexOf("Restent réservés à l’offre Analyse :"));
    const reservedSentence = reserved.slice(0, reserved.indexOf("Le déblocage est consommé"));
    for (const received of [
      "enchère plafond",
      "estimation détaillée",
      "ventes comparables",
      "budget travaux",
      "lecture",
      "historique",
      "urbanisme",
      "rapport enregistré",
      "rapport PDF",
      "export PDF",
    ]) {
      expect(reservedSentence).not.toContain(received);
    }
  });

  it("ne comptent plus la fourchette de valeur ni l'écart chiffré dans Découverte", () => {
    const text = pageText(<TermsPage />);
    expect(text).not.toContain("informations essentielles");
    expect(text).toContain(
      "un niveau d’écart entre la mise à prix et le marché, sans chiffre, et un aperçu chiffré de l’analyse (nombre de ventes comparables, de points relevés dans les pièces, de passages), lorsqu’ils sont disponibles",
    );
    expect(text).toContain(
      "La valeur estimée, sa fourchette et l’écart chiffré avec la mise à prix ne sont pas compris dans Découverte : ils sont ouverts par un déblocage ou par l’offre Analyse.",
    );
  });

  it("disent quand le déblocage est consommé, rendu ou non, et quand un déblocage redevient disponible", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Le déblocage est consommé quand vous le confirmez, après affichage du nombre restant ; il n’est pas consommé en cas d’erreur technique, ni si la vente est déjà débloquée.",
    );
    expect(text).toContain(
      "Il est rendu automatiquement si la vente est retirée avant d’avoir lieu, par la juridiction, le notaire ou la source.",
    );
    expect(text).toContain(
      "Si Immojudis retire elle-même la vente ou en suspend la publication pour une raison qui lui est imputable (par exemple une erreur de publication ou la suspension d’une source décidée par Immojudis), le déblocage est rendu sur simple demande adressée à contact@immojudis.example, qui reçoit une réponse sous un mois. Il n’est pas rendu si la vente est reportée ou adjugée.",
    );
    // Le canal est l'adresse de contact : Mes droits n'a pas de demande de restitution.
    expect(text).not.toContain("depuis Mes droits ou à l’adresse de contact");
    expect(text).toContain(
      "tant qu’elle est en ligne sur Immojudis, dans la limite de 24 mois après le déblocage, et tant que votre compte existe. Passé ce délai de 24 mois, le déblocage n’est plus conservé et un déblocage redevient disponible.",
    );
    for (const gone of [
      "déblocages mensuels",
      "chaque mois civil",
      "mois du déblocage",
      "Le compteur est remis",
      "ne sont pas reportés",
    ]) {
      expect(text).not.toContain(gone);
    }
  });

  it("disent le sort des ventes débloquées après un abonnement Analyse", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Pendant un abonnement Analyse, aucun déblocage n’est consommé. À la fin de l’abonnement, le compte revient à Découverte : les ventes que vous aviez déjà débloquées restent accessibles ; les autres ventes consultées pendant l’abonnement redeviennent soumises au déblocage.",
    );
  });

  it("limitent la clause de modification au déblocage du compte gratuit, avec trente jours de préavis", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Immojudis peut modifier ou supprimer le déblocage du compte gratuit pour l’avenir, en vous prévenant au moins 30 jours à l’avance par un message dans l’application ou à l’adresse email de votre compte. Les ventes que vous avez déjà débloquées restent accessibles dans les conditions ci-dessus, et les déblocages déjà consommés ne sont pas affectés. Si la modification ne vous convient pas, vous pouvez fermer votre compte gratuitement depuis Mes droits.",
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
      "le contournement des quotas, notamment la création de plusieurs comptes pour multiplier les déblocages, la redistribution massive des données",
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
      "src/components/SalePublicSaleSteps.tsx",
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

describe("mentions légales : données publiques réutilisées", () => {
  it("cite Géorisques, le Géoportail de l'urbanisme, la DVF, la carte des loyers de l'ANIL et le zonage tendu", () => {
    const text = pageText(<LegalPage />);
    expect(text).toContain("Données publiques réutilisées");
    expect(text).toContain("Géorisques (ministère de la Transition écologique, BRGM)");
    expect(text).toContain("territoires à risque important d’inondation (TRI)");
    expect(text).toContain("Géoportail de l’urbanisme (IGN), via l’API Carto");
    expect(text).toContain("servitudes d’utilité publique PM1");
    expect(text).toContain("Demandes de valeurs foncières (DVF)");
    expect(text).toContain(
      "« Estimations ANIL, à partir des données du Groupe SeLoger et de leboncoin »",
    );
    expect(text).toContain("Zonage des communes en zone tendue");
    expect(text.match(/Licence Ouverte 2\.0/g)?.length).toBeGreaterThanOrEqual(5);
    expect(text).toContain("ne signifient pas que ces organismes cautionnent");
  });

  it("le code explique pourquoi les mentions ANIL et zone tendue restent (lot loyers fusionné dans la même mise en production)", () => {
    const source = readFileSync(resolve(__dirname, "legal.tsx"), "utf8");
    expect(source).toMatch(
      /Garder les mentions « ANIL » \(carte des loyers\) et « zone tendue »[\s\S]*fusionné dans la même mise en production/,
    );
  });
});

describe("mentions légales : repère « Pépite »", () => {
  it("portent la version 2026-10-26.2, en vigueur le 26 octobre 2026 ; la 2026-10-26.1 est archivée", () => {
    const text = pageText(<LegalPage />);
    expect(LEGAL_DOCUMENTS.legal.version).toBe("2026-10-26.2");
    expect(PREVIOUS_LEGAL_DOCUMENTS.legal.version).toBe("2026-10-26.1");
    expect(LEGAL_DOCUMENTS.legal.effectiveDate).toBe("26 octobre 2026");
    expect(text).toContain(
      `Version ${LEGAL_DOCUMENTS.legal.version}, en vigueur le ${LEGAL_DOCUMENTS.legal.effectiveDate}.`,
    );
  });

  it("rangent la Pépite, les enchères et offres plafond parmi les aides à la lecture, sans conseil ni garantie", () => {
    const text = pageText(<LegalPage />);
    expect(text).toContain(
      "Les scores, le repère « Pépite », comparables DVF, fourchettes de valeur, prix probables, rendements, analyses de risques, enchères plafond et offres plafond estimées sont des aides à la lecture fondées sur les données disponibles au moment du calcul. Ils ne constituent ni un conseil juridique ou financier, ni une recommandation d’acheter ou d’enchérir, ni une expertise immobilière, ni une garantie de prix, de rentabilité, de financement, d’adjudication ou de revente.",
    );
    expect(text).toContain(
      "Le repère « Pépite » est calculé automatiquement par Immojudis sur des critères publics. Aucune rémunération ne peut l’obtenir ni l’améliorer",
    );
    expect(text).toContain("Une enchère ou une offre plafond est une hypothèse, pas un résultat.");
  });

  it("précise que la mise en relation avec un avocat ne dépend pas du repère", () => {
    expect(pageText(<LegalPage />)).toContain(
      "La mise en relation ne dépend pas du repère « Pépite » : elle n’en est ni une condition ni une conséquence.",
    );
  });
});

describe("politique de confidentialité", () => {
  it("annonce les demandes aux greffes, une fois par vente, avec le plafond quotidien de la configuration", () => {
    const text = pageText(<PrivacyPage courtRegistryDailyCap={2} />);
    expect(text).toContain(
      "Lorsqu’une vente judiciaire n’indique aucune adresse d’avocat, Immojudis peut, après validation manuelle de chaque message, écrire à l’adresse de contact du greffe du tribunal concerné",
    );
    // Même demande que `COURT_REGISTRY_QUESTION` (lot C du 14/11) : aucune pièce n'est demandée.
    expect(text).toContain(
      "pour demander qui est l’avocat poursuivant de la vente ou, à défaut, où et selon quelles modalités un candidat acquéreur peut consulter le cahier des conditions de vente. Aucune pièce n’est demandée au greffe.",
    );
    expect(text).not.toContain("pièces publiques communicables");
    expect(text).toContain(
      "Nous envoyons au plus un message par vente et, par tribunal, au plus 2 messages par jour, sans relance.",
    );
    expect(pageText(<PrivacyPage courtRegistryDailyCap={1} />)).toContain(
      "au plus 1 message par jour",
    );
    expect(pageText(<PrivacyPage />)).toContain("au plus 3 messages par jour");
  });

  it("informe de la conservation des messages écrits à l’adresse de réponse sans dossier ouvert", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Si vous écrivez à l’adresse de réponse d’Immojudis sans qu’un dossier soit ouvert, nous conservons votre adresse, votre nom, l’objet, la date et un extrait de votre message, pour le lire et vous répondre ou enregistrer votre demande. Base : intérêt légitime. Conservation : 12 mois si nous vous avions écrit, 21 jours sinon. Droits et opposition : ",
    );
  });

  it("décrit le journal des emails : intérêt légitime, 90 jours (97 au plus), prestataire à 30 jours, consultations tracées", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Journal des emails envoyés par Immojudis");
    expect(text).toContain("Le contenu du message n’est pas conservé dans ce journal.");
    expect(text).toContain(
      "Intérêt légitime : contrôler la bonne remise des messages, répondre à vos questions sur un email reçu ou non reçu, détecter les abus et prouver l’envoi.",
    );
    expect(text).toContain(
      "90 jours après l’envoi (suppression à la purge hebdomadaire, soit 97 jours au plus)",
    );
    expect(text).toContain(
      "Notre prestataire d’envoi conserve de son côté le contenu des messages et ses propres journaux 30 jours.",
    );
    expect(text).toContain(
      "Resend envoie et reçoit nos courriels. Il conserve le contenu des messages et les journaux de remise 30 jours, aux États-Unis",
    );
    expect(text).toContain(
      "Ces consultations sont tracées pendant 6 mois, sans le contenu ni l’adresse.",
    );
    expect(text).toContain("figurent aussi dans le journal des emails (90 jours).");
    expect(text).toContain("journal des emails liés à votre compte");
  });

  it("décrit le traitement du déblocage : base contractuelle et conservation de 24 mois au plus, sans compteur mensuel", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Déblocage de vente (offre Découverte)");
    expect(text).not.toContain("Déblocages mensuels");
    expect(text).toContain("Identifiant de compte, vente débloquée, date du déblocage");
    expect(text).toContain(
      "Exécution du contrat : appliquer l’avantage et sa limite prévus par les conditions générales",
    );
    expect(text).toContain(
      "24 mois au plus après le déblocage, et suppression avec le compte. Si la vente est supprimée du site, le lien avec la vente est coupé : seuls l’identifiant de compte et la date du déblocage sont gardés, dans la même limite de 24 mois, pour que le déblocage reste compté.",
    );
    expect(text).not.toContain("mois civil");
  });

  it("dit que l'essai gratuit à l'inscription n'est plus proposé", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Essai gratuit de l’offre Analyse à l’inscription, qui n’est plus proposé, et prévention des abus",
    );
    expect(text).toContain(
      "Intérêt légitime : réserver l’essai, tant qu’il était proposé, à une fois par personne et prévenir les comptes multiples.",
    );
    expect(text).not.toContain("si l’essai ne vous est pas accordé");
  });

  it("dit que le journal d’usage relie un compte à la vente débloquée, pendant 24 mois au plus", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "journal des fonctions utilisées (compte, vente ou tribunal concerné, date), par exemple pour l’historique ou la valeur d’une vente débloquée",
    );
    expect(text).toContain(
      "le journal d’usage (quotas et fonctions utilisées) est conservé 24 mois au plus",
    );
    expect(text).toContain("distinct des événements de parcours par compte, conservés 90 jours");
    // Les mesures agrégées ne sont plus décrites comme « d'usage » sans personne.
    expect(text).toContain(
      "Événements de parcours du navigateur, agrégés et à valeurs fermées, sans identifiant de personne ni de compte",
    );
    expect(text).not.toContain("Événements d’usage et de parcours agrégés");
    expect(text).toContain("Journaux applicatifs et données techniques : 24 mois au plus");
  });

  it("décrit les rappels d'audience : consentement, retrait en un clic, journal, Resend, durée du journal", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Rappels d’audience");
    expect(text).toContain(
      "Consentement daté et versionné (date, version du texte, date de retrait)",
    );
    expect(text).toContain("journal d’envoi (vente, type de rappel, date, état)");
    expect(text).toContain("par Resend");
    expect(text).toContain("retirable à tout moment en un clic");
    // Durée réelle des migrations : 180 jours, purge hebdomadaire (au plus 187 jours).
    expect(text).toContain("180 jours après sa création");
    expect(text).toContain("au plus 187 jours environ");
  });

  it("décrit les ventes passées suivies : instantané, base contractuelle, 6 mois, suppression par la personne", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Ventes passées suivies");
    expect(text).toContain(
      "nom de l’avocat tel qu’il est publié, résultat connu, et votre statut et votre enchère plafond enregistrés",
    );
    expect(text).toContain(
      "Si vous le notez, le prix final de l’adjudication (facultatif, seulement pour une vente marquée « Remporté » ou « Non remporté ») : c’est une donnée financière personnelle, visible de vous seul et jamais envoyée par email",
    );
    expect(text).toContain("Exécution du contrat");
    expect(text).toContain("6 mois après la constitution du résumé");
    expect(text).toContain("suppression à tout moment par la personne");
  });

  it("décrit le profil d'investisseur : données financières facultatives, base contractuelle, effacement par la personne", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Profil d’investisseur (facultatif)");
    expect(text).toContain(
      "Apport personnel, marge cible, budget de travaux au m² et stratégie (revendre ou louer)",
    );
    expect(text).toContain("Ce sont des données financières personnelles");
    expect(text).toContain(
      "Exécution du contrat : préremplir, à votre demande, le calcul de l’enchère plafond de chaque vente",
    );
    expect(text).toContain("« Effacer mon profil »");
  });

  it("décrit les photos tirées des pièces, procès-verbaux descriptifs compris, et leur retrait sur demande", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Photos du bien tirées des pièces des ventes");
    expect(text).toContain(
      "procès-verbal descriptif dressé par un commissaire de justice, anciennement huissier de justice",
    );
    expect(text).toContain("12 au plus par vente");
    expect(text).toContain("retrait sur demande, au plus tard un mois après sa réception");
    expect(text).toContain(
      "la photo est retirée au plus tard un mois après votre demande, sans que vous ayez à créer de compte.",
    );
  });

  it("dit que les coordonnées de l'organisateur publiées dans l'annonce sont visibles des comptes connectés", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Le nom et les coordonnées professionnelles (adresse, téléphone, adresse e-mail) de l’organisateur de la vente (avocat, notaire, étude ou service), tels qu’ils sont publiés dans l’annonce d’origine (pour une vente notariale, celle d’immobilier.notaires.fr), sont visibles des personnes connectées à un compte, offre Découverte comprise.",
    );
    // Vérifié dans la collecte : une adresse masquée n'est jamais remise dans un champ publié.
    expect(text).toContain(
      "Une adresse e-mail masquée par le site d’origine n’est jamais affichée",
    );
  });

  it("décrit le profil d'investisseur comme stocké par l'hébergeur seul", () => {
    expect(pageText(<PrivacyPage />)).toContain(
      "jamais envoyées par email ni communiquées à des tiers (seul notre hébergeur, Supabase, les stocke)",
    );
  });

  it("déclare le contrôle du risque d'inondation : coordonnées d'une vente seulement, BRGM et IGN, supprimé avec la vente", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Repère « Pépite » : contrôle du risque d’inondation d’une vente");
    expect(text).toContain(
      "Coordonnées géographiques d’une vente (jamais celles d’un visiteur ni les données d’un compte), transmises aux services de l’État ; résultat du contrôle conservé pour chaque vente (les coordonnées ne sont pas copiées ; la position n’est gardée que sous la forme d’une empreinte, une pseudonymisation)",
    );
    expect(text).toContain(
      "Intérêt légitime à informer le public sur des ventes publiques avec un repère fiable. Opposition et retrait par email, sans compte",
    );
    expect(text).toContain("Supprimé avec la vente");
    expect(text).toContain(
      "Les coordonnées géographiques d’une vente (et non celles d’une personne) sont aussi transmises au Bureau de recherches géologiques et minières (Géorisques) et à l’Institut national de l’information géographique et forestière (API Carto, Géoportail de l’urbanisme) pour contrôler les risques et les servitudes du bien.",
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
    expect(text).toContain("noms remplacés par leur rôle autant que possible");
    expect(text).toContain("en cas d’oubli, écrivez-nous pour demander le retrait");
    expect(text).toContain("ce remplacement est automatique et peut laisser passer un nom");
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
      "Si vous êtes cité dans une annonce, en cas d’oubli notamment, écrivez à contact@immojudis.example pour demander la rectification ou le retrait, sans créer de compte.",
    );
  });

  it("liste Mapbox, le prestataire d'IA et le rapport d'erreurs parmi les destinataires", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Mapbox (cartes, vignettes et géocodage)");
    expect(text).toContain("le prestataire d’IA utilisé pour lire les annonces et les pièces");
    expect(text).toContain("Replicate");
    expect(text).toContain("le service de rapport d’erreurs lorsqu’il est configuré");
  });

  it("décrit les événements rattachés au compte, les clics des emails, les retours sur les signaux et les instantanés d'estimation", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Mesure du parcours des personnes connectées");
    expect(text).toContain("clic sur un lien d’un email d’alerte ou de rappel");
    expect(text).toContain("90 jours après l’événement");
    expect(text).toContain("Retours « Utile » ou « Pas pertinent » sur les signaux d’une vente");
    expect(text).toContain("90 jours après le retour");
    expect(text).toContain("Instantanés d’estimation de marché avant l’audience");
    expect(text).toContain("36 mois après la date d’audience");
    expect(text).toContain("Aucun texte libre, aucune adresse IP");
  });

  it("dit que l'interrupteur de mesure d'audience ne couvre pas les événements par compte, et que l'opposition se fait par écrit", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "ne couvre pas ces événements : vous pouvez vous y opposer depuis /mes-droits (demande d’opposition) ou par écrit",
    );
    expect(text).toContain(
      "L’interrupteur ci-dessous ne couvre pas les événements liés à votre compte",
    );
    expect(text).toContain("(demande d’opposition) ou écrivez à contact@immojudis.example");
    expect(text).toContain("indiquez le lien de l’annonce dans votre demande");
    expect(text).toContain(
      "arrêter un repère dont la précision se dégrade. Vous pouvez vous y opposer depuis /mes-droits (demande d’opposition) ou par écrit",
    );
    expect(text).toContain("Elles sont traitées comme des données personnelles");
    expect(text).not.toContain("Ces informations ne désignent pas une personne");
  });

  it("n'affirme aucun réglage Google Analytics non vérifié (paramètre de recherche, 14 mois)", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).not.toContain("paramètre de recherche");
    expect(text).not.toContain("14 mois");
    expect(text).toContain("selon la durée réglée dans notre compte Google Analytics");
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
      "Intérêt légitime à publier des informations exactes sur les ventes ; un outil peut préparer les projets de messages, mais, à ce jour, chaque message envoyé est validé par un membre de l’équipe. Les messages ne contiennent aucune offre commerciale. La liste d’opposition (adresse et identité professionnelle) est conservée en application de l’obligation de respecter le droit d’opposition (art. 21 RGPD).",
    );
    // Le mode réel du pilote reste verrouillé : aucun message ne part sans validation, et la page
    // annonce qu'elle changerait avant tout envoi automatique.
    expect(text).toContain(
      "À ce jour, chaque message est relu et validé par un membre de l’équipe avant son envoi : un outil peut préparer à l’avance des projets de messages, mais aucun ne part sans cette validation. Si nous décidions d’envoyer certains messages automatiquement, cette page serait modifiée avant, et ces messages le diraient.",
    );
    expect(text).not.toContain("déclenchés puis validés");
    expect(text).not.toContain("administrateur");
    // L'email du demandeur n'est jamais communiqué (share_requester_email reste à false).
    expect(text).not.toContain("consentement pour la communication de l’email de réponse");
    expect(text).not.toContain("service professionnel");
    expect(text).toContain("aucune sollicitation commerciale");
  });

  it("décrit les professionnels contactés : sources, durées, opposition, droits sans compte", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).not.toContain("Enrichissement de dossier supervisé par Immojudis");
    expect(text).toContain(
      "Professionnels contactés par Immojudis (avocats, notaires, commissaires de justice, gestionnaires)",
    );
    expect(text).toContain(
      "relevés dans l’annonce publique de la vente, dans un annuaire professionnel officiel (annuaire des avocats du CNB, annuaires de certains barreaux, annuaire des commissaires de justice) ou sur le site de son cabinet ou de son étude. La source et la date de relevé sont indiquées dans chaque message.",
    );
    expect(text).not.toContain("annuaire des notaires");
    expect(text).toContain("Base juridique : intérêt légitime à publier des informations exactes");
    expect(text).toContain("Les messages ne contiennent aucune offre commerciale.");
    expect(text).toContain(
      "Les adresses professionnelles figurant dans les annonces publiées sur Licitor, dont l’adresse e-mail est masquée par le site, sont relevées automatiquement lors de la collecte de l’annonce ; elles sont conservées en interne, jamais publiées, et ne servent qu’à une demande d’information validée par un membre de l’équipe.",
    );
    expect(text).toContain(
      "Une adresse relevée à la collecte de l’annonce et non utilisée pour un envoi est conservée tant que le détail de l’annonce est relu, jamais rafraîchie après la date de la vente, et supprimée au plus tard 28 jours après la dernière consultation de l’annonce (purge hebdomadaire, seuil de 21 jours).",
    );
    expect(text).toContain(
      "Les données d’un échange sont conservées 12 mois si vous ne répondez pas, 24 mois après le dernier échange si vous répondez.",
    );
    expect(text).not.toContain("conservées un mois au plus si aucun message n’est envoyé");
    expect(text).toContain(
      "Vous pouvez vous opposer à tout moment, sans motif, par le lien « Ne plus être contacté » de chaque message ou à contact@immojudis.example. Votre opposition est enregistrée et vaut pour tous nos canaux.",
    );
    expect(text).toContain(
      "Pour exercer ces droits, écrivez à contact@immojudis.example ; aucun compte n’est nécessaire.",
    );
    expect(text).toContain(
      "liste d’opposition : au moins 3 ans après l’opposition, puis tant que l’agent d’information est exploité, avec revue annuelle",
    );
    expect(text).toContain("adresses invalides (rebond permanent) : 12 mois");
  });

  it("décrit l'opposition par adresse, identité et structure rattachée avec certitude, et l'exclusion de 24 mois", () => {
    const text = pageText(<PrivacyPage />);
    // Relecture du 14/11 : l'accord de Licitor n'est pas affirmé dans la page.
    expect(text).not.toContain("accord de Licitor");
    expect(text).toContain(
      "Elle vaut pour votre adresse et pour votre identité professionnelle : nous ne vous écrirons pas non plus à une autre adresse.",
    );
    // Portée réelle des clés de structure (contact-structure.ts) : domaine propre ou numéro d'office.
    expect(text).toContain(
      "Faite depuis l’adresse de contact d’un cabinet, d’une étude ou d’un service, elle vaut pour toutes les adresses que nous pouvons rattacher avec certitude à cette structure : celles du même nom de domaine, pour un cabinet, une étude ou un service doté de son propre nom de domaine, ou, pour une étude notariale, celles du même numéro d’office. Elle ne s’étend pas aux autres adresses d’une messagerie partagée (par exemple avocat.fr, ou notaires.fr sans numéro d’office). Pour un service de l’État, dont les adresses partagent le domaine gouv.fr, elle vaut pour l’adresse du service, mais pas pour les adresses nominatives de ses agents : chacun d’eux peut s’opposer de la même façon.",
    );
    expect(text).not.toContain("elle vaut pour toutes les adresses de cette structure");
    expect(text).toContain(
      "Les échanges déjà intervenus sont conservés jusqu’au terme indiqué plus haut (12 ou 24 mois), seulement pour pouvoir répondre d’une réclamation, puis supprimés. Seules votre adresse, votre identité professionnelle et la date de votre opposition sont gardées au-delà, pour ne plus vous solliciter.",
    );
    expect(text).toContain(
      "est gardée 24 mois, pour qu’aucun message ne vous soit plus préparé automatiquement, et un membre de l’équipe vérifiera avant toute nouvelle prise de contact. Pour ne plus du tout être contacté, utilisez le lien « Ne plus être contacté ».",
    );
    expect(text).toContain("identité signalée comme « mauvais destinataire » : 24 mois");
    expect(text).toContain(
      "Ces adresses et nos échanges ne servent jamais à proposer ou vendre la mise en avant payante d’Immojudis, ni au classement des avocats, ni à la mise en relation.",
    );
  });

  it("décrit l'affichage des informations transmises, sans nom, leur retrait et l'opposition qui vaut retrait", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Ces valeurs sont affichées sans votre nom.");
    // La promesse « sans nom » ne couvre plus les pièces, dont seul le libellé est neutre.
    expect(text).not.toContain("sans le nom de la personne qui les a transmises");
    expect(text).toContain(
      "une pièce transmise est publiée sous un libellé neutre (qualité de l’expéditeur et date de réception ; le type de pièce est indiqué à part) ; son contenu est publié tel qu’il a été transmis.",
    );
    expect(text).not.toMatch(/masqu\w+ (?:les|des) noms/);
    expect(text).toContain(
      "Pour une information venue de l’avocat poursuivant, la fiche indique cette qualité et la date de son message, et rappelle de la vérifier dans le cahier des conditions de vente : comme la fiche nomme par ailleurs l’organisateur de la vente, l’avocat reste identifiable.",
    );
    expect(text).toContain(
      "Vous pouvez à tout moment, sans motif, demander le retrait de ce que vous nous avez transmis, en répondant à notre message ou en écrivant à contact@immojudis.example : nous le retirons alors de la fiche, au plus tard un mois après réception de votre demande.",
    );
    expect(text).toContain(
      "Elle vaut aussi demande de retrait des informations que vous nous avez transmises : nous les retirons de la fiche dans le même délai.",
    );
    expect(text).toContain("information affichée sur une fiche : supprimée avec la fiche");
  });

  it("donne les durées codées des journaux de provenance, sans en promettre d'autres", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "Le journal des publications est supprimé avec la fiche ; l’historique des modifications de la fiche est conservé 12 mois après chaque modification ; le journal des décisions et la file de relecture n’ont pas encore de durée fixée : nous l’indiquerons ici dès qu’elle le sera.",
    );
    expect(text).not.toContain("en cours de validation");
  });

  it("ne publie pas l'outil de recherche automatisé tant qu'il n'existe pas", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).not.toContain("outil de recherche automatisé");
    expect(text).not.toContain("agent-information");
  });

  it("nomme le prestataire d'IA et GitHub, sans affirmer de mécanisme de transfert non vérifié", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("les réponses des professionnels contactés (Replicate, États-Unis)");
    expect(text).toContain("Resend (envoi et réception des courriels)");
    expect(text).toContain("GitHub (exécution des traitements automatisés)");
    expect(text).toContain(
      "Pour obtenir une copie des garanties qui existent, écrivez à contact@immojudis.example ; aucun compte n’est nécessaire. Pour Replicate, aucune garantie n’est établie à ce jour (voir ci-dessus).",
    );
    expect(text).toContain(
      "Nos sous-traitants agissent sur nos instructions, dans le cadre d’un contrat, sauf les exceptions indiquées ci-dessous (Replicate, et Resend pour ses propres données d’usage).",
    );
    // Seul le paragraphe sur Resend cite les clauses contractuelles types, vérifiées dans son accord de
    // sous-traitance ; sa certification au cadre UE–États-Unis, non vérifiée sur la liste officielle, n'est
    // pas affirmée.
    expect(text.split("clauses contractuelles types")).toHaveLength(2);
    expect(text).toContain(
      "journaux de remise 30 jours, aux États-Unis. Ce transfert est encadré par les clauses contractuelles types adoptées par la Commission européenne (décision (UE) 2021/914 du 4 juin 2021), intégrées à son accord de sous-traitance.",
    );
    expect(text).toContain(
      "Resend traite aussi, en tant que responsable de traitement distinct, certaines données d’usage (adresses d’expédition et de destination, journaux d’activité) pour la sécurité de son service et la prévention de la fraude, selon sa propre politique de confidentialité.",
    );
    expect(text).toContain("Plus Five Five, Inc.");
    expect(text).not.toContain("se déclare certifié");
    // « Décision d'adéquation » n'apparaît que pour dire qu'aucune ne s'applique à Replicate.
    expect(text.split("décision d’adéquation")).toHaveLength(2);
    expect(text).toContain("aucune décision d’adéquation ne s’applique donc");
  });

  it("nomme Replicate et le modèle, et dit qu'aucune garantie de transfert n'est vérifiée (J18)", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Replicate (Replicate, LLC, à San Francisco, États-Unis)");
    expect(text).toContain(
      "À la date de cette version, le modèle utilisé (référence « qwen/qwen3-7-plus »",
    );
    expect(text).toContain(
      "Ces données sont transférées aux États-Unis. À la date de cette version, ce transfert ne repose sur aucune garantie prévue par le RGPD que nous ayons pu vérifier. Replicate ne figure pas, à notre connaissance, parmi les organisations certifiées au cadre de protection des données UE–États-Unis : aucune décision d’adéquation ne s’applique donc. Aucun accord de sous-traitance ni aucune clause contractuelle type n’est signé avec lui. Nous ne savons pas non plus si Replicate fait exécuter ce modèle par un autre prestataire, ni dans quel pays. Nous mettrons cette page à jour dès que ces points seront établis. Pour toute question, ou pour vous opposer à ce traitement, écrivez à contact@immojudis.example.",
    );
    expect(text).not.toContain("Deux points restent à confirmer");
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

  it("soumet Google Analytics au consentement, déclare Google et propose de retirer l'accord", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain("Mesure d’audience par Google Analytics (avec votre accord)");
    expect(text).toContain("sans accord, Google Analytics n’est pas chargé");
    expect(text).toContain("Cookies : 13 mois au plus, sans prolongation à chaque visite");
    expect(text).toContain(
      "Google (mesure d’audience Google Analytics, uniquement avec votre accord)",
    );
    expect(text).toContain("cadre de protection des données UE–États-Unis");
    expect(text).toContain("Retirer votre accord arrête les envois et efface ces cookies.");
    cleanup();

    const { getByRole, container } = render(<PrivacyPage />);
    expect(container.querySelector("section#cookies")).not.toBeNull();
    const toggle = getByRole("switch", {
      name: "J’accepte les cookies de Google Analytics sur ce navigateur",
    }) as HTMLInputElement;
    // Aucun accord par défaut : la case n'est jamais pré-cochée.
    expect(toggle.checked).toBe(false);
  });
});
