import { describe, expect, it } from "vitest";
import { LAUNCH_OFFER_DATA_TEXT } from "../src/lib/launch-offer";
import {
  LAUNCH_OFFER_END_NEEDS_ANALYSIS,
  LAUNCH_OFFER_END_STAYS,
} from "../src/lib/launch-offer-end-lists";
import {
  launchOfferEndNoticeSubject,
  renderLaunchOfferEndNoticeEmail,
} from "./launch-offer-end-notice";

const props = {
  endsOnLabel: "30 novembre 2026",
  accountUrl: "https://immojudis.test/compte",
  unsubscribeUrl: "https://immojudis.test/api/notification-preferences/unsubscribe?token=abc",
};

describe("renderLaunchOfferEndNoticeEmail", () => {
  it("annonce la date, dit ce qui change et ce que deviennent les données", async () => {
    const { html, text } = await renderLaunchOfferEndNoticeEmail(props);

    for (const body of [html, text]) {
      expect(body).toContain("30 novembre 2026");
      expect(body.toLowerCase()).toContain("ce qui reste gratuit");
      expect(body.toLowerCase()).toContain("ce qui demandera l’offre analyse");
      for (const item of [...LAUNCH_OFFER_END_STAYS, ...LAUNCH_OFFER_END_NEEDS_ANALYSIS]) {
        expect(body).toContain(item.replace(/&/g, "&amp;").slice(0, 24));
      }
      expect(body).toContain("https://immojudis.test/compte");
    }
    // La phrase sur les données est celle des textes publics, pas une nouvelle promesse.
    expect(text).toContain(LAUNCH_OFFER_DATA_TEXT);
    expect(html).toContain("Immojudis");
    expect(html).not.toContain("IMMOJUDIS");
  });

  it("contient le lien de désinscription et le dit sans toucher au compte", async () => {
    const { html, text } = await renderLaunchOfferEndNoticeEmail(props);

    expect(html).toContain("token=abc");
    expect(text).toContain("token=abc");
    expect(text).toContain("Ne plus recevoir ce message");
    expect(text).toContain("Votre compte n’est pas modifié");
  });

  it("reste factuel : ni prix, ni compte à rebours, ni incitation à s’abonner", async () => {
    const { text } = await renderLaunchOfferEndNoticeEmail(props);

    expect(text).not.toMatch(/€|\bTTC\b|dernière chance|dépêchez|avant qu|abonn|profitez|urgent/i);
  });

  it("met la date dans l’objet", () => {
    expect(launchOfferEndNoticeSubject("30 novembre 2026")).toBe(
      "Immojudis : fin de l’offre de lancement prévue le 30 novembre 2026",
    );
  });
});
