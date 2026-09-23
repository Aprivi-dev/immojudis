import { describe, expect, it } from "vitest";
import { renderInformationRequestEmail } from "./information-request";

const bodyText = [
  "Bonjour Maître Dupont,",
  "",
  "Je vous contacte pour ImmoJudis, service indépendant d’information sur les ventes immobilières judiciaires. Nous vérifions la fiche de cette vente :",
  "",
  "Référence de l’annonce : Maison — 33000 Bordeaux",
  "Audience annoncée : 12 septembre 2026",
  "",
  "Pourriez-vous nous confirmer les points suivants ou nous transmettre les pièces disponibles ?",
  "- Le cahier des conditions de vente est-il disponible ?",
  "- Disposez-vous de photographies récentes ?",
].join("\n");

describe("renderInformationRequestEmail", () => {
  it("rend un message professionnel avec suivi, réponse directe et transparence", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Maison à Bordeaux — précisions sur la vente",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      appUrl: "https://immojudis.com",
    });

    expect(message.html).toContain("IMMOJUDIS");
    expect(message.html).toContain("IJ-8F31A290");
    expect(message.html).toContain("mailto:enquete+1234@reponses.immojudis.com");
    expect(message.html).toContain("ImmoJudis n’agit pas au nom d’un tribunal");
    expect(message.html).toContain("https://immojudis.com");
    expect(message.text.toLocaleLowerCase("fr-FR")).toContain(
      "informations sur une vente judiciaire",
    );
    expect(message.text).toContain("Le cahier des conditions de vente est-il disponible ?");
    expect(message.text).toContain("Une IA aide à lire et classer les réponses");
    expect(message.text).not.toContain("validation explicite d’un utilisateur");
    expect(message.html).not.toContain("DEMANDE DOCUMENTAIRE SÉCURISÉE");
    expect(message.html).not.toContain("?subject=Re");
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
