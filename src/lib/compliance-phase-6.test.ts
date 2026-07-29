import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCommercialConfirmationReadiness,
  checkoutConsentSchema,
} from "@/lib/commercial-acceptance";
import {
  assertPaidOfferLegalReadiness,
  LEGAL_DOCUMENTS,
  legalConfigurationStatus,
} from "@/lib/legal-documents";
import { privacyRequestAdminUpdateSchema, privacyRequestInputSchema } from "@/lib/privacy-requests";

const completeLegalEnvironment = {
  NEXT_PUBLIC_LEGAL_ENTITY_NAME: "ImmoJudis SAS",
  NEXT_PUBLIC_LEGAL_ENTITY_FORM: "SAS",
  NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS: "1 rue de Paris, 75001 Paris",
  NEXT_PUBLIC_LEGAL_REGISTRATION: "RCS Paris 000 000 000",
  NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR: "Direction ImmoJudis",
  NEXT_PUBLIC_LEGAL_CONTACT_EMAIL: "contact@immojudis.fr",
  NEXT_PUBLIC_LEGAL_CONTACT_PHONE: "+33 1 00 00 00 00",
  NEXT_PUBLIC_LEGAL_MEDIATOR_NAME: "Médiateur de la consommation",
  NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS: "1 rue de la Médiation, 75001 Paris",
  NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE: "https://mediateur.example",
};

describe("phase 6 compliance contracts", () => {
  it.each([
    ["legal", "src/routes/legal.tsx"],
    ["terms", "src/routes/conditions-generales.tsx"],
    ["privacy", "src/routes/privacy.tsx"],
  ] as const)("anchors the %s document version to its committed source", (document, path) => {
    const digest = createHash("sha256")
      .update(readFileSync(resolve(path)))
      .digest("hex");
    expect(digest).toBe(LEGAL_DOCUMENTS[document].sha256);
  });

  it("blocks paid checkout while mandatory legal identity is incomplete", () => {
    expect(legalConfigurationStatus({})).toMatchObject({ ready: false });
    expect(() => assertPaidOfferLegalReadiness({})).toThrow(/checkout est suspendu/i);
  });

  it("accepts a complete legal identity", () => {
    expect(legalConfigurationStatus(completeLegalEnvironment)).toEqual({
      ready: true,
      missing: [],
    });
    expect(() => assertPaidOfferLegalReadiness(completeLegalEnvironment)).not.toThrow();
  });

  it("blocks checkout without the durable confirmation channel", () => {
    expect(() => assertCommercialConfirmationReadiness(completeLegalEnvironment)).toThrow(
      /confirmation contractuelle indisponible/i,
    );
    expect(() =>
      assertCommercialConfirmationReadiness({
        ...completeLegalEnvironment,
        NEXT_PUBLIC_APP_URL: "https://immojudis.example",
        RESEND_API_KEY: "re_test",
        ALERT_EMAIL_FROM: "ImmoJudis <commandes@immojudis.example>",
      }),
    ).not.toThrow();
  });

  it("requires every commercial acknowledgement and the current document versions", () => {
    expect(
      checkoutConsentSchema.safeParse({
        termsAccepted: true,
        termsVersion: LEGAL_DOCUMENTS.terms.version,
        privacyVersion: LEGAL_DOCUMENTS.privacy.version,
        paymentObligationAcknowledged: true,
        immediatePerformanceRequested: true,
        withdrawalInformationAcknowledged: true,
      }).success,
    ).toBe(true);
    expect(
      checkoutConsentSchema.safeParse({
        termsAccepted: true,
        termsVersion: "obsolete",
        privacyVersion: LEGAL_DOCUMENTS.privacy.version,
        paymentObligationAcknowledged: false,
        immediatePerformanceRequested: true,
        withdrawalInformationAcknowledged: true,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded rights requests and rejects empty details", () => {
    expect(
      privacyRequestInputSchema.safeParse({
        requestType: "access",
        message: "Je souhaite obtenir une copie des données associées à mon compte.",
      }).success,
    ).toBe(true);
    expect(
      privacyRequestInputSchema.safeParse({ requestType: "access", message: "a".repeat(4001) })
        .success,
    ).toBe(false);
  });

  it("requires a documented resolution before an operator closes a rights request", () => {
    const base = {
      requestId: "11111111-1111-4111-8111-111111111111",
      status: "completed",
    };
    expect(privacyRequestAdminUpdateSchema.safeParse(base).success).toBe(false);
    expect(
      privacyRequestAdminUpdateSchema.safeParse({
        ...base,
        resolutionCode: "access_copy_delivered",
        operatorNotes: "Copie transmise sur un support durable.",
      }).success,
    ).toBe(true);
  });
});
