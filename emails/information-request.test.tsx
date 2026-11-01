import { describe, expect, it } from "vitest";
import {
  informationAgentAddressOrigin,
  type InformationAgentLegalFooter,
} from "../src/lib/information-agent-compliance";
import {
  DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
  renderInformationAgentEmailContent,
  type InformationAgentEmailVariable,
} from "../src/lib/information-agent-email-template";
import {
  COURT_REGISTRY_EMAIL_TEMPLATE,
  COURT_REGISTRY_QUESTION,
} from "../src/lib/information-agent/court-registry-template";
import {
  INFORMATION_REQUEST_PREHEADER,
  renderInformationRequestEmail,
} from "./information-request";

const bodyText = [
  "Bonjour Maître Jean Dupont,",
  "",
  "Je vous contacte pour Immojudis, site privé d’information sur les ventes immobilières judiciaires. Nous vérifions la fiche de cette vente :",
  "",
  "Référence de l’annonce : Maison — 33000 Bordeaux",
  "Audience annoncée : 12 septembre 2026",
  "",
  "Pourriez-vous nous confirmer les points suivants ou nous transmettre les pièces disponibles ?",
  "- Le cahier des conditions de vente est-il disponible ?",
  "- Disposez-vous de photographies récentes ?",
].join("\n");

const legalFooter: InformationAgentLegalFooter = {
  controllerName: "Immojudis SAS",
  controllerAddress: "1 rue de la Paix, 33000 Bordeaux",
  contactEmail: "dpo@immojudis.test",
  saleReference: "Maison — 33000 Bordeaux",
  addressOrigin:
    "Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor (https://www.licitor.com/annonce/10/99/72/109972.html), consultée le 14/10/2026.",
  addressOriginUrl: "https://www.licitor.com/annonce/10/99/72/109972.html",
  aiProvider: { id: "replicate", name: "Replicate", country: "États-Unis" },
  privacyUrl: "https://immojudis.com/privacy",
  optOutUrl: "https://immojudis.com/api/information-agent/opt-out?e=YUBiLmZy&t=" + "a".repeat(64),
};

describe("renderInformationRequestEmail", () => {
  it("rend un message professionnel avec suivi, réponse directe et transparence", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux — précisions sur la vente",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      appUrl: "https://immojudis.com",
      contributionUrl: "https://immojudis.com/contribuer/mission#secret-token",
    });

    expect(message.html).toContain('alt="Immojudis"');
    // Le nom de marque s'écrit « Immojudis », jamais en capitales.
    expect(message.html).not.toContain("IMMOJUDIS");
    expect(message.html).toContain("IJ-8F31A290");
    expect(message.html).toContain("mailto:enquete+1234@reponses.immojudis.com");
    expect(message.html).toContain("Immojudis n’agit pas au nom d’un tribunal");
    expect(message.html).toContain(
      "Merci de ne transmettre que des pièces que vous êtes autorisé à partager.",
    );
    expect(message.html).toContain("https://immojudis.com/contribuer/mission#secret-token");
    expect(message.text).toContain("- Le cahier des conditions de vente est-il disponible ?");
    expect(message.text).not.toContain("01Pouvez");
    expect(
      message.text.match(/https:\/\/immojudis\.com\/contribuer\/mission#secret-token/g),
    ).toHaveLength(1);
    expect(message.text).toContain("Une IA aide à lire et classer les réponses");
    expect(message.html).not.toContain("DEMANDE DOCUMENTAIRE SÉCURISÉE");
    expect(message.html).not.toContain("?subject=Re");
  });

  it("reste purement informatif : aucune invitation à créer un compte, aucune prospection", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux — précisions sur la vente",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      appUrl: "https://staging.immojudis.com",
      legalFooter,
    });

    for (const output of [message.html, message.text]) {
      expect(output).not.toContain("Créer un compte professionnel");
      expect(output).not.toContain("Vous publiez d’autres ventes");
      expect(output).not.toContain("service professionnel");
      expect(output).not.toContain("mode=professional");
      expect(output).not.toContain("Vous avez d’autres ventes à partager");
      expect(output).toContain("Ce message ne contient aucune offre commerciale.");
      expect(output).toContain("intérêt légitime à publier des informations exactes");
      expect(output).not.toContain("Service indépendant d’aide à l’analyse");
    }
    // Aucun lien vers le site hors opposition, politique et dépôt : ni logo cliquable, ni domaine au pied.
    expect(message.html).not.toContain('href="https://staging.immojudis.com"');
    expect(message.html).not.toContain('href="https://immojudis.com"');
    expect(message.html).not.toMatch(/>immojudis\.com</);
    expect(message.html).not.toContain("utm_");
  });

  it("s'ouvre comme un courrier : formule d'appel, présentation, origine de l'adresse, puis la vente", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      legalFooter,
    });
    const origin = message.text.indexOf(
      "figure dans l’annonce publique de cette vente sur Licitor",
    );
    expect(origin).toBeGreaterThan(-1);
    // Pas de bandeau de dossier : le texte brut commence par « Bonjour », la référence est au pied.
    expect(message.text.startsWith("Bonjour Maître Jean Dupont,")).toBe(true);
    expect(origin).toBeGreaterThan(message.text.indexOf("Je vous contacte pour Immojudis"));
    expect(origin).toBeLessThan(message.text.indexOf("Référence de l’annonce : Maison"));
    expect(message.text).toContain(
      "(https://www.licitor.com/annonce/10/99/72/109972.html), consultée le 14/10/2026",
    );
    expect(message.html).not.toContain("Quelques points à vérifier sur une vente");
    expect(message.html).not.toContain("Vérification d’une annonce");
    expect(message.html).not.toContain("Pourquoi vous ?");
    expect(message.html).not.toContain("<h1");
    expect(message.text.indexOf("Référence de suivi")).toBeGreaterThan(
      message.text.indexOf("Disposez-vous de photographies récentes ?"),
    );
  });

  it("supprime l'ancienne invitation même si elle figure encore dans un brouillon", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux",
      bodyText: `${bodyText}\n\nPOUR LES PROFESSIONNELS\nVous avez d’autres ventes à partager ?\nVous publiez d’autres ventes ? Un compte professionnel Immojudis vous permet de nous les transmettre directement.\nCréer un compte professionnel : https://immojudis.com/login?mode=professional\n\nBien cordialement,\nL’équipe Immojudis`,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
    });

    expect(message.text).not.toContain("Créer un compte professionnel");
    expect(message.text).not.toContain("Vous publiez d’autres ventes");
    expect(message.text).not.toContain("POUR LES PROFESSIONNELS");
    expect(message.text).toContain("Bien cordialement");
  });

  it("ajoute le pied RGPD de l'article 14 avec opposition en un clic", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux — précisions sur la vente",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      appUrl: "https://immojudis.com",
      legalFooter,
    });

    for (const output of [message.html, message.text]) {
      expect(output).toContain("Immojudis SAS");
      expect(output).toContain("1 rue de la Paix, 33000 Bordeaux");
      expect(output).toContain("figure dans l’annonce publique de cette vente sur Licitor");
      expect(output).toContain("https://immojudis.com/privacy");
      expect(output).toContain("https://immojudis.com/api/information-agent/opt-out?e=YUBiLmZy&");
      // Pied complet : finalité, données, destinataires dont l'IA, durées, droits, CNIL.
      expect(output).toContain("Pourquoi ce message");
      expect(output).toContain("la vente Maison — 33000 Bordeaux");
      expect(output).toContain("votre nom, votre fonction, votre adresse professionnelle");
      expect(output).toContain("Replicate (États-Unis)");
      expect(output).toContain("12 mois si vous ne répondez pas");
      expect(output).toContain("24 mois après le dernier échange");
      expect(output).toContain("accès, rectification, effacement et limitation");
      expect(output).toContain("Vous pouvez vous opposer à tout moment, sans motif");
      expect(output).toContain("https://www.cnil.fr/fr/plaintes");
      expect(output).not.toContain("retrouvée automatiquement");
    }
    // Le lien d'opposition ne promet plus « un clic » : la page affiche d'abord une confirmation.
    expect(message.html).toContain(">Ne plus être contacté<");
    expect(message.html).not.toContain("(un clic)");
    expect(message.text).not.toContain("(un clic)");
    expect(message.text).toContain("Ne plus être contacté : https://immojudis.com/api/");
    expect(message.html).toContain("Politique de confidentialité et vos droits");
    expect(message.html).toContain("Réclamation auprès de la CNIL");
  });

  it("annonce la recherche automatique seulement quand l'agent a retrouvé l'adresse", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      legalFooter: { ...legalFooter, automatedSearch: true },
    });
    for (const output of [message.html, message.text]) {
      expect(output).toContain(
        "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une page publique (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.",
      );
    }
  });

  it("met toujours en forme l'ancienne étiquette « Référence de l’annonce » d'un modèle publié", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux",
      bodyText:
        "Référence de l’annonce : Maison — 33000 Bordeaux\nAudience annoncée : 12 septembre 2026",
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
    });
    expect(message.html).toMatch(/Référence de l’annonce : <strong[^>]*>Maison — 33000 Bordeaux</);
  });

  it("met en forme la vente, annonce les points à vérifier et propose le dépôt avant la signature", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux, audience du 12/09/2026 : vérification de l’annonce",
      bodyText: [
        "Bonjour Maître Jean Dupont,",
        "",
        "Vente concernée : Maison — 33000 Bordeaux",
        "Audience annoncée, à confirmer : 12 septembre 2026",
        "Mise à prix annoncée : 85 000 €",
        "",
        "- Le cahier des conditions de vente est-il disponible ?",
        "- Disposez-vous de photographies récentes ?",
        "",
        "Répondre est facultatif.",
        "",
        "Bien cordialement,",
        "L’équipe Immojudis",
      ].join("\n"),
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      contributionUrl: "https://immojudis.com/contribuer/mission#secret-token",
    });

    // Bloc « vente » : une ligne « libellé : valeur » en gras pour la valeur, pas un paragraphe.
    expect(message.html).toMatch(/Vente concernée : <strong[^>]*>Maison — 33000 Bordeaux</);
    expect(message.html).toMatch(
      /Audience annoncée, à confirmer : <strong[^>]*>12 septembre 2026</,
    );
    // Une seule « référence » désigne le dossier : « Référence de suivi », au pied du courrier.
    expect(message.text.match(/Référence de suivi : IJ-8F31A290/g)).toHaveLength(1);
    expect(message.text.indexOf("Référence de suivi")).toBeGreaterThan(
      message.text.indexOf("Bien cordialement"),
    );
    // Aperçu de la messagerie : ce qu'on attend, et que c'est facultatif (pas l'objet répété).
    expect(INFORMATION_REQUEST_PREHEADER).toBe(
      "Quelques points sur une annonce ; répondre est facultatif.",
    );
    expect(message.html).toContain(INFORMATION_REQUEST_PREHEADER);
    const deposit = message.text.indexOf("Déposer des pièces pour ce dossier");
    expect(deposit).toBeGreaterThan(message.text.indexOf("Répondre est facultatif."));
    expect(deposit).toBeLessThan(message.text.indexOf("Bien cordialement"));
    expect(message.text).toContain("sur immojudis.com");
    expect(message.text).toContain("Ce lien est propre à ce dossier.");
  });

  it("garde le courrier lisible à 375 px : mots longs coupés, bouton en pleine largeur", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      contributionUrl: "https://immojudis.com/contribuer/mission#secret-token",
      legalFooter,
    });
    // Le pied (liens d'annonce, adresses) peut contenir des mots plus larges que l'écran.
    expect(message.html.match(/overflow-wrap:anywhere/g)!.length).toBeGreaterThanOrEqual(2);
    expect(message.html).toContain("max-width: 480px");
    expect(message.html).toMatch(/\.ej-btn \{ width: 100% !important; \}/);
  });

  it("échappe le contenu éditable fourni par l’utilisateur", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Demande <test>",
      bodyText: "Bonjour,\n\n<script>alert('xss')</script>",
      replyTo: "enquete+safe@reponses.immojudis.com",
      caseReference: "IJ-SAFE0001",
    });

    expect(message.html).not.toContain("<script>alert");
    expect(message.html).toContain("&lt;script&gt;");
    expect(message.html).toContain("<title>Demande &lt;test&gt;</title>");
  });
});

/**
 * Les textes juridiques du gabarit précédent (mise en forme de juin-octobre 2026) : chacun doit
 * toujours figurer, mot pour mot, dans le nouveau courrier. Seuls leur place et leur mise en page ont
 * changé. Les phrases sont écrites ici en toutes lettres : si un texte de `information-agent-compliance`
 * ou des modèles est modifié, ce test le dit, il ne le suit pas.
 */
describe("textes juridiques du courrier de l'agent d'information : inchangés mot pour mot", () => {
  const flat = (value: string) =>
    value
      .replace(/<br\s*\/?>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");

  const values = {
    recipient_name: "Maître Jean Dupont",
    salutation: "Bonjour Maître Jean Dupont,",
    sale_title: "Appartement T3 à Bordeaux",
    sale_subject_title: "Appartement T3 à Bordeaux",
    sale_reference: "Appartement T3 à Bordeaux — 33000 Bordeaux",
    location: "33000 Bordeaux",
    tribunal: "Tribunal judiciaire de Bordeaux",
    hearing_date: "14 septembre 2026",
    hearing_line: "Audience annoncée : 14 septembre 2026",
    subject_date: "audience du 14/09/2026",
    starting_price: "85 000 €",
    price_line: "Mise à prix annoncée : 85 000 €",
    questions: "- Le cahier des conditions de vente est-il disponible ?",
  } satisfies Record<InformationAgentEmailVariable, string>;

  const lawyerLegalSentences = [
    "Pourquoi ce message ?",
    "Immojudis vous écrit à titre professionnel pour vérifier des informations sur la vente Maison — 33000 Bordeaux.",
    "Ce message ne contient aucune offre commerciale.",
    "Base : intérêt légitime à publier des informations exactes sur les ventes aux enchères (art. 6.1.f RGPD). Nous vous écrivons au plus une fois par période de 30 jours, toutes ventes confondues, et sans relance.",
    "Responsable de traitement : Immojudis SAS, 1 rue de la Paix, 33000 Bordeaux — dpo@immojudis.test.",
    "Vos données :",
    "votre nom, votre fonction, votre adresse professionnelle et nos échanges. Origine : Votre adresse professionnelle figure dans l’annonce publique de cette vente sur Licitor (https://www.licitor.com/annonce/10/99/72/109972.html), consultée le 14/10/2026.",
    "Recherche de l’adresse :",
    "Cette adresse a été retrouvée automatiquement par un outil d’Immojudis à partir d’une page publique (voir l’origine ci-dessus). L’outil ne conserve aucune copie de la page : seuls l’adresse, le lien de la page, la date de relevé et le critère de rapprochement utilisé sont enregistrés. Ce message a été relu et validé par un membre de l’équipe avant son envoi.",
    "Destinataires :",
    "l’équipe Immojudis et ses prestataires : Vercel et Supabase (hébergement), Resend (envoi et réception des courriels), GitHub (exécution des traitements automatisés) et Replicate (États-Unis), outil d’IA qui aide à lire et classer les réponses. Ces prestataires peuvent traiter des données hors de l’Union européenne, notamment aux États-Unis. Pour savoir quelle garantie s’applique à chacun, ou en obtenir une copie, écrivez à dpo@immojudis.test ; aucun compte n’est nécessaire.",
    "Conservation :",
    "12 mois si vous ne répondez pas ; 24 mois après le dernier échange si vous répondez.",
    "Vos droits :",
    "accès, rectification, effacement et limitation du traitement. Pour les exercer sans créer de compte, écrivez à dpo@immojudis.test ou répondez à ce message. Vous pouvez aussi saisir la CNIL d’une réclamation (cnil.fr/plaintes).",
    "Opposition :",
    "Vous pouvez vous opposer à tout moment, sans motif, à ce que nous vous contactions : utilisez le lien « Ne plus être contacté » ci-dessous ou répondez à ce message. Nous ne vous solliciterons plus, sur aucun de nos canaux. Les données qui ne servent qu’à vous contacter sont supprimées ; les échanges déjà intervenus sont conservés jusqu’à la fin de leur durée normale (12 ou 24 mois), puis supprimés. Seule l’information strictement nécessaire pour ne plus vous solliciter (adresse, identité professionnelle, date de l’opposition) est conservée au-delà, à cette seule fin.",
    "Politique de confidentialité et vos droits",
    "Réclamation auprès de la CNIL",
    "Immojudis n’agit pas au nom d’un tribunal. Une IA aide à lire et classer les réponses ; notre équipe vérifie les informations avant toute mise à jour de la fiche.",
    "Merci de ne transmettre que des pièces que vous êtes autorisé à partager.",
  ];

  const lawyerTemplateSentences = [
    "Immojudis est un site privé d’information sur les ventes immobilières aux enchères, destiné aux candidats acquéreurs. Il ne vend aucun bien et n’agit pas au nom d’un tribunal.",
    "Nous souhaitons vérifier avec vous quelques points de la fiche que nous publions sur cette vente :",
    "Ces informations manquent à la fiche ou y sont contradictoires. Une réponse même partielle nous est utile ; notre équipe la relit avant toute mise à jour de la fiche.",
    "Répondre est facultatif. Le plus simple : un retour à cet email, avec les documents ou photos que vous êtes autorisé à partager. Aucun compte n’est nécessaire.",
    "Ne communiquez que ce qui est communicable à tout candidat acquéreur (cahier des conditions de vente, procès-verbal descriptif, diagnostics, dates de visite, mise à prix, garantie exigée pour enchérir, audience) : votre secret professionnel prime sur notre demande. Si ce dossier est suivi par un collaborateur ou un autre interlocuteur, vous pouvez lui transférer ce message.",
    "Merci par avance : une fiche exacte évite aux candidats de vous interroger sur des points déjà connus.",
    "Bien cordialement, L’équipe Immojudis",
  ];

  const courtTemplateSentences = [
    "Immojudis est un site privé d’information sur les ventes immobilières aux enchères, destiné aux candidats acquéreurs. Il ne vend aucun bien et n’agit pas au nom d’un tribunal.",
    "Nous vous écrivons au sujet d’une vente annoncée devant votre tribunal :",
    "L’annonce publique de cette vente ne mentionne pas l’adresse de l’avocat poursuivant. Notre demande se limite donc à ceci.",
    "Pouvez-vous nous indiquer l’avocat poursuivant de cette vente ou, à défaut, les pièces publiques du dossier (cahier des conditions de vente, procès-verbal descriptif) que vous pouvez communiquer à tout candidat acquéreur, et selon quelles modalités ?",
    "Répondre est facultatif : un simple retour à cet email suffit, et vous pouvez le transmettre au service concerné. Nous écrivons au plus une fois par vente. Ne communiquez que ce qui est communicable à tout candidat acquéreur : les règles de votre juridiction priment sur notre demande.",
    "Merci par avance de votre aide.",
    "Bien cordialement, L’équipe Immojudis",
  ];

  it("courrier à un avocat : pied RGPD, opposition, origine et textes du modèle", async () => {
    const automated: InformationAgentLegalFooter = { ...legalFooter, automatedSearch: true };
    const { bodyText: body } = renderInformationAgentEmailContent({
      template: DEFAULT_INFORMATION_AGENT_EMAIL_TEMPLATE,
      values,
    });
    const message = await renderInformationRequestEmail({
      subject: "Appartement T3 à Bordeaux, audience du 14/09/2026 : vérification de l’annonce",
      bodyText: body,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      contributionUrl: "https://immojudis.com/contribuer/mission#secret-token",
      legalFooter: { ...automated, saleReference: "Maison — 33000 Bordeaux" },
    });
    for (const [name, output] of [
      ["html", flat(message.html)],
      ["texte", flat(message.text)],
    ] as const) {
      for (const sentence of [...lawyerLegalSentences, ...lawyerTemplateSentences]) {
        expect(output, `${name} : ${sentence.slice(0, 60)}`).toContain(sentence);
      }
    }
  });

  it("courrier à un greffe : variante du pied, pas de « Pourquoi vous ? », textes du modèle", async () => {
    const origin = informationAgentAddressOrigin({
      sourceKind: "court_registry_fallback",
      sourceName: "Tribunal judiciaire de Bordeaux",
      observedAt: "2026-10-14",
    });
    const { bodyText: body } = renderInformationAgentEmailContent({
      template: COURT_REGISTRY_EMAIL_TEMPLATE,
      values: {
        ...values,
        salutation: "Madame, Monsieur,",
        questions: `- ${COURT_REGISTRY_QUESTION}`,
      },
    });
    const message = await renderInformationRequestEmail({
      subject:
        "Vente aux enchères du 14/09/2026 (Bordeaux) : avocat poursuivant ou pièces publiques",
      bodyText: body,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      legalFooter: {
        ...legalFooter,
        addressOrigin: origin.text,
        addressOriginUrl: null,
        courtRegistryDailyCap: 3,
      },
    });
    const courtLegal = [
      "Base : intérêt légitime à obtenir des informations exactes sur les ventes aux enchères (art. 6.1.f RGPD). Nous écrivons au plus une fois par vente et, pour un même tribunal, au plus 3 messages par jour, sans relance.",
      "l’adresse de contact de votre greffe et, si vous répondez, le nom, la fonction et les coordonnées de la personne qui répond, ainsi que nos échanges. Origine : adresse de contact de votre juridiction, issue du référentiel des tribunaux tenu par Immojudis, relevée le 14/10/2026 ; l’annonce ne donne aucune adresse d’avocat.",
      "Vous pouvez vous opposer à tout moment, sans motif, à ce que nous vous contactions",
      "Ne plus être contacté",
    ];
    for (const [name, output] of [
      ["html", flat(message.html)],
      ["texte", flat(message.text)],
    ] as const) {
      for (const sentence of [...courtTemplateSentences, ...courtLegal]) {
        expect(output, `${name} : ${sentence.slice(0, 60)}`).toContain(sentence);
      }
      expect(output).toContain("Madame, Monsieur,");
      expect(output).not.toContain("Pourquoi vous ?");
      expect(output).not.toContain("Quelques points à vérifier");
    }
    // L'origine du greffe n'est pas répétée en ouverture : elle figure une seule fois, dans « Vos données ».
    expect(message.text.match(/adresse de contact de votre juridiction/g)).toHaveLength(1);
  });
});
