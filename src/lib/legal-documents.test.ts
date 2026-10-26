import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPaidOfferLegalReadiness,
  LEGAL_DOCUMENTS,
  PREVIOUS_LEGAL_DOCUMENTS,
  legalConfigurationStatus,
  legalPublisherConfigurationStatus,
  publicLegalPublisher,
  type LegalPublisher,
} from "./legal-documents";

const COMPLETE_ENVIRONMENT = {
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

const COMPLETE_PUBLISHER: LegalPublisher = {
  entityName: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_ENTITY_NAME,
  legalForm: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_ENTITY_FORM,
  capital: null,
  address: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS,
  registration: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_REGISTRATION,
  vatNumber: null,
  publicationDirector: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR,
  contactEmail: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL,
  contactPhone: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_CONTACT_PHONE,
  mediatorName: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_MEDIATOR_NAME,
  mediatorAddress: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS,
  mediatorWebsite: COMPLETE_ENVIRONMENT.NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE,
};

afterEach(() => vi.unstubAllEnvs());

describe("legal publisher configuration", () => {
  it("keeps the client and server guards aligned, including the mediator fields", () => {
    const serverStatus = legalConfigurationStatus(COMPLETE_ENVIRONMENT);
    const clientStatus = legalPublisherConfigurationStatus(COMPLETE_PUBLISHER);

    expect(clientStatus).toEqual(serverStatus);
    expect(clientStatus).toEqual({ ready: true, missing: [] });

    const missingMediator = { ...COMPLETE_PUBLISHER, mediatorWebsite: " " };
    const incompleteStatus = legalPublisherConfigurationStatus(missingMediator);
    expect(incompleteStatus).toEqual({
      ready: false,
      missing: ["NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE"],
    });
    expect(
      legalConfigurationStatus({
        ...COMPLETE_ENVIRONMENT,
        NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE: " ",
      }),
    ).toEqual(incompleteStatus);
    expect(() =>
      assertPaidOfferLegalReadiness({
        ...COMPLETE_ENVIRONMENT,
        NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE: " ",
      }),
    ).toThrow(/checkout est suspendu/i);
  });

  it("builds the client publisher from the statically referenced public variables", () => {
    for (const [name, value] of Object.entries(COMPLETE_ENVIRONMENT)) {
      vi.stubEnv(name, value);
    }

    expect(publicLegalPublisher()).toMatchObject(COMPLETE_PUBLISHER);
    expect(legalPublisherConfigurationStatus()).toEqual({ ready: true, missing: [] });
  });
});

describe("versions précédentes archivées", () => {
  it.each(["terms", "legal"] as const)(
    "garde le code source exact de la version précédente de %s, à l'empreinte déclarée",
    (document) => {
      const previous = PREVIOUS_LEGAL_DOCUMENTS[document];
      const digest = createHash("sha256")
        .update(readFileSync(resolve(previous.archive)))
        .digest("hex");
      expect(digest).toBe(previous.sha256);
      expect(previous.version).not.toBe(LEGAL_DOCUMENTS[document].version);
      expect(previous.sha256).not.toBe(LEGAL_DOCUMENTS[document].sha256);
    },
  );

  it("garde la version précédente des CGU applicable jusqu'à l'entrée en vigueur de la nouvelle", () => {
    expect(PREVIOUS_LEGAL_DOCUMENTS.terms.version).toBe("2026-10-25.1");
    expect(PREVIOUS_LEGAL_DOCUMENTS.terms.applicableUntil).toBe(
      LEGAL_DOCUMENTS.terms.effectiveDate,
    );
  });
});
