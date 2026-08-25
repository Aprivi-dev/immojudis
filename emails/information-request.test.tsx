import { describe, expect, it } from "vitest";
import { renderInformationRequestEmail } from "./information-request";

const bodyText = [
  "Bonjour Maître Dupont,",
  "",
  "ImmoJudis agit à la demande d’un utilisateur intéressé par cette vente.",
  "",
  "Référence de l’annonce : Maison — 33000 Bordeaux",
  "Date annoncée : 12 septembre 2026",
  "Mise à prix annoncée : 80 000 €",
  "",
  "Pourriez-vous nous préciser les éléments suivants ?",
  "- Le cahier des conditions de vente est-il disponible ?",
  "- Disposez-vous de photographies récentes ?",
].join("\n");

describe("renderInformationRequestEmail", () => {
  it("rend un message professionnel avec suivi, réponse directe et transparence", async () => {
    const message = await renderInformationRequestEmail({
      subject: "Demande d’informations — Bordeaux",
      bodyText,
      replyTo: "enquete+1234@reponses.immojudis.com",
      caseReference: "IJ-8F31A290",
      appUrl: "https://immojudis.com",
    });

    expect(message.html).toContain("IMMOJUDIS");
    expect(message.html).toContain("IJ-8F31A290");
    expect(message.html).toContain("mailto:enquete+1234@reponses.immojudis.com");
    expect(message.html).toContain("Ce message n’émane ni du tribunal ni d’une administration");
    expect(message.html).toContain("https://immojudis.com");
    expect(message.text.toLocaleLowerCase("fr-FR")).toContain(
      "demande d’informations relative à une vente immobilière",
    );
    expect(message.text).toContain("Le cahier des conditions de vente est-il disponible ?");
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
