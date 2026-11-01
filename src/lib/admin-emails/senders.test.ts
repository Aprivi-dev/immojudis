import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATES } from "@/lib/email-templates/registry";
import type { EmailAddressEnv } from "./env";
import { addressDomain, buildAddressRows } from "./senders";

const EMPTY: EmailAddressEnv = {
  ALERT_EMAIL_FROM: undefined,
  RESEND_FROM_EMAIL: undefined,
  TRANSACTIONAL_EMAIL_FROM: undefined,
  INFORMATION_AGENT_EMAIL_FROM: undefined,
  CONTACT_EMAIL_FROM: undefined,
  EMAIL_REPLY_TO: undefined,
  NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: undefined,
  CONTACT_EMAIL_TO: undefined,
  OPERATIONS_ALERT_EMAIL_TO: undefined,
  INFORMATION_AGENT_INBOUND_DOMAIN: undefined,
};

const rows = (env: Partial<EmailAddressEnv>) =>
  Object.fromEntries(
    buildAddressRows({ ...EMPTY, ...env }, EMAIL_TEMPLATES).map((row) => [row.variable, row]),
  );

describe("addressDomain", () => {
  it("lit le domaine d'une adresse nue ou avec nom affiché", () => {
    expect(addressDomain("Immojudis <Alertes@Immojudis.com>")).toBe("immojudis.com");
    expect(addressDomain("compte@mail.immojudis.com")).toBe("mail.immojudis.com");
    expect(addressDomain("pas une adresse")).toBeNull();
    expect(addressDomain(null)).toBeNull();
  });
});

describe("expéditeurs effectifs", () => {
  it("signale tout comme non configuré quand l'environnement est vide", () => {
    const result = rows({});
    for (const row of Object.values(result)) {
      expect(row.value, row.variable).toBeNull();
      expect(row.origin).toBe("missing");
      expect(row.consequence, row.variable).toBeTruthy();
    }
  });

  it("applique les replis du code : transactionnel sur alertes, ancienne variable, contact légal", () => {
    const result = rows({
      RESEND_FROM_EMAIL: "Immojudis <ancien@immojudis.com>",
      NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.com",
    });
    expect(result.ALERT_EMAIL_FROM).toMatchObject({
      value: "Immojudis <ancien@immojudis.com>",
      origin: "fallback",
      domain: "immojudis.com",
    });
    expect(result.TRANSACTIONAL_EMAIL_FROM).toMatchObject({
      value: "Immojudis <ancien@immojudis.com>",
      origin: "fallback",
      fallbackFrom: "ALERT_EMAIL_FROM",
    });
    expect(result.EMAIL_REPLY_TO).toMatchObject({
      value: "contact@immojudis.com",
      origin: "fallback",
    });
    expect(result.CONTACT_EMAIL_TO).toMatchObject({
      value: "contact@immojudis.com",
      origin: "fallback",
    });
  });

  it("ne replie ni l'agent ni le formulaire de contact sur l'expéditeur des alertes", () => {
    const result = rows({ ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.com>" });
    expect(result.INFORMATION_AGENT_EMAIL_FROM.value).toBeNull();
    expect(result.CONTACT_EMAIL_FROM.value).toBeNull();
    expect(result.TRANSACTIONAL_EMAIL_FROM.value).toBe("Immojudis <alertes@immojudis.com>");
  });

  it("préfère la valeur propre à chaque variable et normalise le domaine de réception", () => {
    const result = rows({
      ALERT_EMAIL_FROM: "Immojudis <alertes@immojudis.com>",
      TRANSACTIONAL_EMAIL_FROM: "Immojudis <compte@immojudis.com>",
      INFORMATION_AGENT_EMAIL_FROM: " Assistant <assistant@immojudis.com> ",
      EMAIL_REPLY_TO: "reponses@immojudis.com",
      INFORMATION_AGENT_INBOUND_DOMAIN: " Reponses.Immojudis.com ",
    });
    expect(result.TRANSACTIONAL_EMAIL_FROM).toMatchObject({
      value: "Immojudis <compte@immojudis.com>",
      origin: "configured",
    });
    expect(result.INFORMATION_AGENT_EMAIL_FROM.value).toBe("Assistant <assistant@immojudis.com>");
    expect(result.EMAIL_REPLY_TO.origin).toBe("configured");
    expect(result.INFORMATION_AGENT_INBOUND_DOMAIN).toMatchObject({
      value: "reponses.immojudis.com",
      domain: "reponses.immojudis.com",
    });
  });

  it("dit quels gabarits utilisent chaque expéditeur", () => {
    const result = rows({});
    expect(result.ALERT_EMAIL_FROM.usedBy).toContain("Alerte de recherche");
    expect(result.TRANSACTIONAL_EMAIL_FROM.usedBy).toEqual(
      expect.arrayContaining(["Paiement échoué", "Confirmation de commande"]),
    );
    expect(result.INFORMATION_AGENT_EMAIL_FROM.usedBy).toHaveLength(2);
    expect(result.CONTACT_EMAIL_FROM.usedBy).toEqual(["Message du formulaire de contact"]);
  });
});
