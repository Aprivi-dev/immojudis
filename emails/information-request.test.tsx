import { describe, expect, it } from "vitest";
import type { InformationAgentLegalFooter } from "../src/lib/information-agent-compliance";
import { renderInformationRequestEmail } from "./information-request";

const bodyText = [
  "Bonjour Maître Jean Dupont,",
  "",
  "Je vous contacte pour Immojudis, service indépendant d’information sur les ventes immobilières judiciaires. Nous vérifions la fiche de cette vente :",
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

    expect(message.html).toContain("IMMOJUDIS");
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
    // Plus de présentation du service ni de lien vers le site : l'identité tient au pied.
    expect(message.html).not.toContain('href="https://staging.immojudis.com"');
    expect(message.html).not.toContain("utm_");
  });

  it("dit d'où vient l'adresse, avec le lien de l'annonce, dès le haut du message", async () => {
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
    expect(origin).toBeLessThan(message.text.indexOf("Bonjour Maître Jean Dupont"));
    expect(message.text).toContain(
      "(https://www.licitor.com/annonce/10/99/72/109972.html), consultée le 14/10/2026",
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
      expect(output).toContain("12 mois si vous ne répondez pas");
      expect(output).toContain("24 mois après le dernier échange");
      expect(output).toContain("accès, rectification, effacement et limitation");
      expect(output).toContain("Vous pouvez vous opposer à tout moment, sans motif");
      expect(output).toContain("https://www.cnil.fr/fr/plaintes");
      expect(output).not.toContain("outil de recherche automatisé");
    }
    expect(message.html).toContain("Ne plus être contacté (un clic)");
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
        "Cette adresse a été retrouvée par un outil de recherche automatisé d’Immojudis, qui consulte ponctuellement des pages publiques ; seuls l’adresse retenue, le lien de la page et la date de consultation sont conservés. Ce message a été relu et validé par un membre de l’équipe avant envoi.",
      );
    }
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
  });
});
