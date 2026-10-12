import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPaidOfferLegalReadiness,
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
