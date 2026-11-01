import { describe, expect, it } from "vitest";
import { verifyUnsubscribeToken } from "./email-unsubscribe-token";
import { LAUNCH_OFFER_END_NEEDS_ANALYSIS, LAUNCH_OFFER_END_STAYS } from "./launch-offer-end-lists";
import {
  buildTrialEndMessage,
  TRIAL_END_NO_CHARGE_TEXT,
  TRIAL_END_OPENING_LABEL,
  trialEndDayLabel,
  trialEndSubject,
} from "./trial-end-email";

const env = { EMAIL_UNSUBSCRIBE_SECRET: "secret-de-test" };
const userId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const now = new Date("2026-11-09T12:30:00Z");

function build(overrides: { internal?: boolean; endsAt?: string } = {}) {
  return buildTrialEndMessage({
    userId,
    endsAt: overrides.endsAt ?? "2026-11-11T08:00:00Z",
    recipientEmail: "claire@example.test",
    from: "Immojudis <compte@immojudis.test>",
    appUrl: "https://immojudis.test",
    internal: overrides.internal,
    now,
    env,
  });
}

describe("trialEndDayLabel et trialEndSubject", () => {
  it("écrit le jour de Paris, en toutes lettres", () => {
    expect(trialEndDayLabel("2026-11-14T08:00:00Z")).toBe("14 novembre 2026");
    expect(trialEndDayLabel("2026-11-01T08:00:00Z")).toBe("1er novembre 2026");
    // 23:30 UTC, déjà le lendemain à Paris.
    expect(trialEndDayLabel("2026-11-14T23:30:00Z")).toBe("15 novembre 2026");
    expect(() => trialEndDayLabel("pas une date")).toThrow();
  });

  it("annonce la fin de l'essai dans l'objet, et le dit en mode d'essai", () => {
    expect(trialEndSubject("2026-11-14T08:00:00Z", false)).toBe(
      "Votre essai gratuit de l’offre Analyse se termine le 14 novembre 2026",
    );
    expect(trialEndSubject("2026-11-14T08:00:00Z", true)).toMatch(/^\[Test interne\] Votre essai/);
  });
});

describe("buildTrialEndMessage", () => {
  it("dit ce qui reste gratuit, ce qui se ferme, que rien ne devient payant, et un seul lien d'ouverture", async () => {
    const message = await build();
    for (const body of [message.text, message.html.replace(/<[^>]+>/g, " ")]) {
      for (const item of [...LAUNCH_OFFER_END_STAYS, ...LAUNCH_OFFER_END_NEEDS_ANALYSIS]) {
        expect(body.replace(/\s+/g, " "), item).toContain(item.replace(/\s+/g, " "));
      }
      expect(body).toContain("Ce qui reste gratuit");
      expect(body).toContain("Ce qui se ferme");
      expect(body).toContain(TRIAL_END_NO_CHARGE_TEXT);
      expect(body).toContain(TRIAL_END_OPENING_LABEL);
    }
    expect(message.text).toContain("https://immojudis.test/offres");
    expect(message.html).toContain('href="https://immojudis.test/offres"');
    expect(message.to).toBe("claire@example.test");
  });

  it("n'exerce aucune pression : ni compte à rebours, ni remise, ni promesse de gain", async () => {
    const message = await build();
    const body = `${message.subject} ${message.text}`;
    expect(body).not.toMatch(
      /dernière chance|plus que|vite|urgent|offre limitée|-\s?\d+\s?%|remise/i,
    );
    expect(body).not.toMatch(/gagn|garanti|rentab|économis/i);
    expect(body).not.toMatch(/€/);
  });

  it("porte un lien de désinscription signé, en un clic, aussi en en-tête", async () => {
    const message = await build();
    expect(message.oneClickUnsubscribe).toBe(true);
    const url = new URL(message.unsubscribeUrl);
    expect(url.origin + url.pathname).toBe(
      "https://immojudis.test/api/notification-preferences/unsubscribe",
    );
    expect(verifyUnsubscribeToken(url.searchParams.get("token"), { now, env })).toMatchObject({
      userId,
      scope: { kind: "launch-offer-end" },
    });
    expect(message.text).toContain(message.unsubscribeUrl);
    expect(message.html).toContain("Ne plus recevoir ce message");
  });

  it("prévient en tête du mode d'essai, et seulement alors", async () => {
    const internal = await build({ internal: true });
    expect(internal.subject).toMatch(/^\[Test interne\] /);
    expect(internal.text.startsWith("Test interne")).toBe(true);
    expect(internal.html).toContain("Test interne");
    const real = await build();
    expect(real.subject).not.toContain("Test interne");
    expect(real.html).not.toContain("Test interne");
  });

  it("n'écrit ni le jeton de la personne ni son adresse dans le HTML en dehors du lien signé", async () => {
    const message = await build();
    expect(message.html).not.toContain("claire@example.test");
    expect(message.html).not.toContain(userId);
  });
});
