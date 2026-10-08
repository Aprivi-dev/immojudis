export const LEGAL_DOCUMENTS = {
  legal: {
    version: "2026-07-29.1",
    sha256: "c55e7cffefcf3ebc6e0807e3a234f8d155603e32344cd6ffc0f2478533538df9",
    effectiveDate: "29 juillet 2026",
    path: "/legal",
  },
  terms: {
    version: "2026-10-03.1",
    sha256: "bde7989a42c979643b892c07ef6ed515dc6fe5d425dd5b3d469d5e4a5625f9dc",
    effectiveDate: "3 octobre 2026",
    path: "/conditions-generales",
  },
  privacy: {
    version: "2026-09-19.1",
    sha256: "c429a50826d4729cf9640b86ea7ab9b57913d1f54906d695626f61151e3a6a6f",
    effectiveDate: "19 septembre 2026",
    path: "/privacy",
  },
} as const;

export type LegalPublisher = {
  entityName: string | null;
  legalForm: string | null;
  capital: string | null;
  address: string | null;
  registration: string | null;
  vatNumber: string | null;
  publicationDirector: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  mediatorName: string | null;
  mediatorAddress: string | null;
  mediatorWebsite: string | null;
};

export type LegalConfigurationStatus = {
  ready: boolean;
  missing: string[];
};

const REQUIRED_PUBLISHER_FIELDS = [
  ["entityName", "NEXT_PUBLIC_LEGAL_ENTITY_NAME"],
  ["legalForm", "NEXT_PUBLIC_LEGAL_ENTITY_FORM"],
  ["address", "NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS"],
  ["registration", "NEXT_PUBLIC_LEGAL_REGISTRATION"],
  ["publicationDirector", "NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR"],
  ["contactEmail", "NEXT_PUBLIC_LEGAL_CONTACT_EMAIL"],
  ["contactPhone", "NEXT_PUBLIC_LEGAL_CONTACT_PHONE"],
  ["mediatorName", "NEXT_PUBLIC_LEGAL_MEDIATOR_NAME"],
  ["mediatorAddress", "NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS"],
  ["mediatorWebsite", "NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE"],
] as const;

export const VERCEL_HOSTING_PROVIDER = {
  name: "Vercel Inc.",
  address: "440 N Barranca Avenue #4133, Covina, CA 91723, États-Unis",
  website: "https://vercel.com",
} as const;

export function publicLegalPublisher(): LegalPublisher {
  return {
    entityName: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_NAME),
    legalForm: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_FORM),
    capital: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_CAPITAL),
    address: filled(process.env.NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS),
    registration: filled(process.env.NEXT_PUBLIC_LEGAL_REGISTRATION),
    vatNumber: filled(process.env.NEXT_PUBLIC_LEGAL_VAT_NUMBER),
    publicationDirector: filled(process.env.NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR),
    contactEmail: filled(process.env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL),
    contactPhone: filled(process.env.NEXT_PUBLIC_LEGAL_CONTACT_PHONE),
    mediatorName: filled(process.env.NEXT_PUBLIC_LEGAL_MEDIATOR_NAME),
    mediatorAddress: filled(process.env.NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS),
    mediatorWebsite: filled(process.env.NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE),
  };
}

export function legalConfigurationStatus(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): LegalConfigurationStatus {
  const missing = REQUIRED_PUBLISHER_FIELDS.filter(([, name]) => !filled(env[name])).map(
    ([, name]) => name,
  );
  return { ready: missing.length === 0, missing };
}

/** Uses the statically referenced public variables that Next.js includes in the client bundle. */
export function legalPublisherConfigurationStatus(
  publisher: LegalPublisher = publicLegalPublisher(),
): LegalConfigurationStatus {
  const missing = REQUIRED_PUBLISHER_FIELDS.filter(([field]) => !publisher[field]?.trim()).map(
    ([, name]) => name,
  );
  return { ready: missing.length === 0, missing };
}

export function assertPaidOfferLegalReadiness(
  env: Pick<NodeJS.ProcessEnv, string> = process.env,
): void {
  const status = legalConfigurationStatus(env);
  if (!status.ready) {
    throw new Error(
      `Configuration juridique incomplète: ${status.missing.join(", ")}. Le checkout est suspendu.`,
    );
  }
}

export function legalValue(
  value: string | null,
  fallback = "À renseigner avant commercialisation",
) {
  return value ?? fallback;
}

function filled(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
