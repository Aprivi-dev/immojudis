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
      "L’essai gratuit à l’inscription (article 13) est sans paiement : aucun montant n’est dû",
    );
    expect(text).toContain(
      "le délai de 14 jours court à compter de la conclusion de l’abonnement, et le service fourni pendant l’essai gratuit n’est pas pris en compte dans le montant éventuellement dû en cas de rétractation.",
    );
  });

  it("affichent le prix configurable, sans essai dans l'abonnement", () => {
    expect(pageText(<TermsPage />)).toContain(
      `Prix de l’abonnement Analyse : ${DEFAULT_ANALYSIS_OFFER_LABEL}. La souscription n’est pas encore ouverte.`,
    );
    cleanup();
    // Only a label stating the billed price passes the build (scripts/verify-required-env.mjs).
    vi.stubEnv("NEXT_PUBLIC_ANALYSIS_OFFER_LABEL", "59 € / mois");
    expect(pageText(<TermsPage />)).toContain("Prix de l’abonnement Analyse : 59 € / mois");
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
      "Par défaut, les annonces dont la position sur la carte est connue passent avant les autres. Elles sont ensuite classées selon la quantité d’informations renseignées dans leur fiche, puis par date de vente la plus proche. Aucune rémunération ne peut améliorer le rang d’une annonce.",
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

  it("portent la version 2026-10-25.1 (essai gratuit à l'inscription), ancrée par l'empreinte de leur source", () => {
    expect(LEGAL_DOCUMENTS.terms.version).toBe("2026-10-25.1");
    expect(LEGAL_DOCUMENTS.terms.effectiveDate).toBe("25 octobre 2026");
  });

  it("la politique de confidentialité est en version 2026-10-25.1 (essai gratuit à l'inscription)", () => {
    expect(LEGAL_DOCUMENTS.privacy.version).toBe("2026-10-25.1");
    expect(LEGAL_DOCUMENTS.privacy.effectiveDate).toBe("25 octobre 2026");
  });
});

describe("conditions générales : essai gratuit à l'inscription (25/10/2026)", () => {
  it("décrivent l'article 13 : 7 jours après la confirmation, une fois par personne, retour à Découverte", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain("13. Essai gratuit à l’inscription");
    expect(text).toContain(
      `pendant ${ANALYSIS_TRIAL_DAYS} jours à compter de la confirmation de son adresse email. L’essai n’est proposé qu’une fois par personne`,
    );
    expect(text).toContain(
      "n’est pas ouvert aux adresses jetables. Cette vérification est automatique",
    );
    expect(text).toContain(
      "en cas d’abus (notamment la création de plusieurs comptes ou l’usage d’adresses jetables pour obtenir plusieurs essais) ou d’impératif technique ou juridique",
    );
    expect(text).toContain(
      "le compte revient à l’offre Découverte, sans frais, sans paiement automatique et sans suppression des données",
    );
    expect(text).toContain("aucun abonnement ne commence sans confirmation dans Stripe.");
    expect(text).toContain(
      "restent conservées tant que votre compte existe et dans les durées de la politique de confidentialité ; elles redeviennent accessibles avec l’offre Analyse",
    );
    expect(text).toContain("Cet essai remplace l’offre de lancement à compter du 25 octobre 2026.");
    expect(text).not.toContain("13. Offre de lancement");
    expect(text).not.toContain("prendront fin au plus tard au lancement officiel du site");
  });

  it("résolvent la contradiction avec le préavis de 30 jours : l'article est spécial à l'essai", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(
      "Cet article est spécial à l’essai : il s’applique à la place du délai de prévenance de 30 jours de l’article 2, qui continue de s’appliquer aux déblocages mensuels de l’offre Découverte.",
    );
    expect(text).toContain(
      "Ce délai ne s’applique pas à l’essai gratuit à l’inscription, régi par l’article 13.",
    );
  });

  it("ajoutent l'article 14 : modification des conditions avec 30 jours de préavis", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain("14. Modification des conditions");
    expect(text).toContain(
      "au moins 30 jours avant l’entrée en vigueur, sauf pour l’essai gratuit (article 13) et sauf obligation légale ou impératif de sécurité. Une modification n’est jamais appliquée à un abonnement en cours sans l’accord du client.",
    );
  });

  it("ne mettent plus d'essai avec carte bancaire dans l'abonnement", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain("L’abonnement ne comprend pas de période d’essai");
    expect(text).not.toContain("nécessite l’enregistrement d’une carte bancaire");
    expect(text).not.toContain("la fin de l’essai et la date du premier prélèvement");
    expect(text).not.toContain("Une résiliation pendant l’essai évite le premier prélèvement");
  });

  it("tirent le nombre de favoris et la durée de l'essai du code, pas du texte", () => {
    const text = pageText(<TermsPage />);
    expect(text).toContain(`${PLAN_LIMITS.decouverte.favoriteSales} favoris au maximum`);
    expect(text).not.toContain("trois favoris");
    expect(text).not.toContain("sept jours");
  });

  it("disent que la souscription n'est pas encore ouverte, à côté du prix", () => {
    expect(pageText(<TermsPage />)).toContain(
      `Prix de l’abonnement Analyse : ${DEFAULT_ANALYSIS_OFFER_LABEL}. La souscription n’est pas encore ouverte.`,
    );
  });

  it("disent que les rappels et avertissements sont indicatifs (article 8)", () => {
    expect(pageText(<TermsPage />)).toContain(
      "Les rappels et avertissements sont indicatifs. Ils ne dispensent pas de vérifier la date et le statut de la vente auprès de l’avocat poursuivant.",
    );
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
      "Les autres fonctions de l’offre Analyse, notamment l’export PDF ou CSV, les rapports enregistrés, le budget travaux, l’estimation détaillée et les ventes comparables, les alertes avancées et la mise en relation avec un avocat référencé, restent réservées à cette offre.",
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
      "Il n’est pas restitué si la vente est ensuite reportée ou adjugée, ni si elle est retirée par la juridiction ou la source. Si Immojudis retire elle-même la vente ou en suspend la publication pour une raison qui lui est imputable (par exemple une erreur de publication ou la suspension d’une source décidée par Immojudis), le déblocage est restitué sur simple demande adressée à",
    );
    expect(text).toMatch(
      /adressée à .+, qui reçoit une réponse sous un mois\. Le déblocage restitué est rendu sur le mois du déblocage : une demande reçue après la fin de ce mois ne rend pas de déblocage, car les déblocages ne sont pas reportés\./,
    );
    // Le canal est l'adresse de contact : Mes droits n'a pas de demande de restitution.
    expect(text).not.toContain("depuis Mes droits ou à l’adresse de contact");
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
      "Pendant un abonnement Analyse ou l’essai gratuit de l’article 13, aucun déblocage n’est consommé. À la fin de l’abonnement ou de l’essai, le compte revient à Découverte : les ventes que vous aviez déjà débloquées restent accessibles ; les autres ventes consultées pendant l’abonnement ou l’essai redeviennent soumises aux déblocages.",
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
      "24 mois au plus après le déblocage, et suppression avec le compte. Si la vente est supprimée du site, le lien avec la vente est coupé : seuls l’identifiant de compte et la date du déblocage sont gardés, jusqu’à la fin du mois civil du déblocage (effacement lors de la purge hebdomadaire qui suit), pour que le compteur du mois ne soit pas remis à zéro.",
    );
  });

  it("dit que le journal d’usage relie un compte à la vente débloquée, pendant 24 mois au plus", () => {
    const text = pageText(<PrivacyPage />);
    expect(text).toContain(
      "journal des fonctions utilisées (compte, vente ou tribunal concerné, date), par exemple pour l’historique ou la valeur d’une vente débloquée",
    );
    expect(text).toContain("le journal d’usage est conservé 24 mois au plus");
    // Les mesures agrégées ne sont plus décrites comme « d'usage » sans personne.
    expect(text).toContain("Événements de parcours agrégés, sans identifiant de personne");
    expect(text).not.toContain("Événements d’usage et de parcours agrégés");
    expect(text).toContain("Événements d’usage et journaux applicatifs : 24 mois au plus");
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
    expect(text).toContain("Exécution du contrat");
    expect(text).toContain("6 mois après la constitution du résumé");
    expect(text).toContain("suppression à tout moment par la personne");
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
      "Intérêt légitime à publier des informations exactes sur les ventes ; les échanges sont déclenchés et chaque message envoyé est validé par un administrateur. Les messages ne contiennent aucune offre commerciale. La liste d’opposition (adresse et identité professionnelle) est conservée en application de l’obligation de respecter le droit d’opposition (art. 21 RGPD).",
    );
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
      "Pour savoir quelle garantie s’applique à chacun, ou en obtenir une copie, écrivez à contact@immojudis.example ; aucun compte n’est nécessaire.",
    );
    expect(text).not.toContain("clauses contractuelles types");
    expect(text).not.toContain("décision d’adéquation");
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
