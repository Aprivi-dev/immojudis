import { describe, expect, it } from "vitest";
import type { InformationAgentLegalFooter } from "../src/lib/information-agent-compliance";
import { renderInformationRequestEmail } from "./information-request";

const bodyText = [
  "Bonjour Maître Dupont,",
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
  addressOrigin:
    "Votre adresse professionnelle figure dans une publication accessible au public (Licitor, licitor.com) relative à cette vente.",
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

  it("n'invite jamais à créer un compte professionnel (pas de prospection)", async () => {
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
      expect(output).not.toContain("mode=professional");
      expect(output).not.toContain("Vous avez d’autres ventes à partager");
    }
    expect(message.html).not.toContain("utm_");
  });

  it("supprime l'ancienne invitation même si elle figure encore dans un brouillon", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux",
      bodyText: `${bodyText}\n\nPOUR LES PROFESSIONNELS\nVous avez d’autres ventes à partager ?\nVous pouvez créer un compte.\nCréer un compte professionnel : https://immojudis.com/login?mode=professional\n\nBien cordialement,\nL’équipe Immojudis`,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
    });

    expect(message.text).not.toContain("Créer un compte professionnel");
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
      expect(output).toContain("figure dans une publication accessible au public (Licitor");
      expect(output).toContain("https://immojudis.com/privacy");
      expect(output).toContain("https://immojudis.com/api/information-agent/opt-out?e=YUBiLmZy&");
      expect(output).toContain("30 jours");
    }
    expect(message.html).toContain("Ne plus être contacté (un clic)");
    expect(message.html).toContain("Politique de confidentialité et vos droits");
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
