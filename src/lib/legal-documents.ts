export const LEGAL_DOCUMENTS = {
  legal: {
    version: "2026-07-29.1",
    sha256: "226b41a85d6adba14bfa0613311d85141e6a342b5b338753e92d4984f3557e99",
    effectiveDate: "29 juillet 2026",
    path: "/legal",
  },
  terms: {
    version: "2026-07-29.1",
    sha256: "3b46da5f455e9420656e5269ee45749907f6fc01f9fe25a78bcd81e769560378",
    effectiveDate: "29 juillet 2026",
    path: "/conditions-generales",
  },
  privacy: {
    version: "2026-08-24.1",
    sha256: "1c246c3112b9f50aac74d732701846ee592d861292d2ca92f8c6d857c23b9247",
    effectiveDate: "24 août 2026",
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
  const required = [
    ["NEXT_PUBLIC_LEGAL_ENTITY_NAME", env.NEXT_PUBLIC_LEGAL_ENTITY_NAME],
    ["NEXT_PUBLIC_LEGAL_ENTITY_FORM", env.NEXT_PUBLIC_LEGAL_ENTITY_FORM],
    ["NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS", env.NEXT_PUBLIC_LEGAL_ENTITY_ADDRESS],
    ["NEXT_PUBLIC_LEGAL_REGISTRATION", env.NEXT_PUBLIC_LEGAL_REGISTRATION],
    ["NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR", env.NEXT_PUBLIC_LEGAL_PUBLICATION_DIRECTOR],
    ["NEXT_PUBLIC_LEGAL_CONTACT_EMAIL", env.NEXT_PUBLIC_LEGAL_CONTACT_EMAIL],
    ["NEXT_PUBLIC_LEGAL_CONTACT_PHONE", env.NEXT_PUBLIC_LEGAL_CONTACT_PHONE],
    ["NEXT_PUBLIC_LEGAL_MEDIATOR_NAME", env.NEXT_PUBLIC_LEGAL_MEDIATOR_NAME],
    ["NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS", env.NEXT_PUBLIC_LEGAL_MEDIATOR_ADDRESS],
    ["NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE", env.NEXT_PUBLIC_LEGAL_MEDIATOR_WEBSITE],
  ] as const;
  const missing = required.filter(([, value]) => !filled(value)).map(([name]) => name);
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
