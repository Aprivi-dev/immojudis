/**
 * Dates d'effet des versions du 26/10/2026 (repère « Pépite »). Elles n'entrent pas dans l'empreinte
 * du texte.
 *
 * - CGU 2026-10-26.1 (articles 2, 8 et 10 : repère « Pépite », enchère ou offre plafond selon la
 *   vente, indépendance vis-à-vis de la publicité) : elles s'appliquent dès l'inscription aux
 *   comptes créés à partir de leur mise en ligne, et le 1er décembre 2026 aux comptes existants.
 *   L'article 14 impose d'informer les titulaires de compte au moins 30 jours avant l'entrée en
 *   vigueur : l'information doit partir au plus tard le 1er novembre 2026. Si elle part plus tard,
 *   repousser cette date (date d'envoi + 30 jours au moins) avant la mise en ligne. Jusque-là, la
 *   version 2026-10-25.1 reste applicable aux comptes existants (voir PREVIOUS_LEGAL_DOCUMENTS).
 * - Mentions légales 2026-10-26.1 (« Estimations, rapports et responsabilité » et « Mise en relation
 *   avec un avocat ») : en vigueur à leur mise en ligne, sans préavis.
 *
 * Historique : la version CGU 2026-10-25.1 est entrée en vigueur le 25 octobre 2026 (article 13
 * « Essai gratuit à l'inscription », qui remplace l'offre de lancement, et article 14 « Modification
 * des conditions » ; relecture de conformité du 25/10/2026, à faire valider par un avocat). La
 * section « Classement, référencement et mise en avant » est en vigueur depuis la version
 * 2026-10-14.1 (14 octobre 2026).
 */
const PEPITE_TERMS_EFFECTIVE_DATE = "1er décembre 2026";
const PEPITE_LEGAL_EFFECTIVE_DATE = "26 octobre 2026";

/**
 * Versions précédentes encore applicables ou à produire sur demande. Le code source exact de
 * chacune est archivé dans `docs/legal-archives/` (extension `.txt`, jamais modifié) et son
 * empreinte contrôlée par `legal-documents.test.ts`.
 */
export const PREVIOUS_LEGAL_DOCUMENTS = {
  terms: {
    version: "2026-10-25.1",
    sha256: "45b05a29108fc2c9b7637d92f9b5e8169971f6d4170ed09cfe3af9f7ae1de39c",
    effectiveDate: "25 octobre 2026",
    applicableUntil: PEPITE_TERMS_EFFECTIVE_DATE,
    archive: "docs/legal-archives/conditions-generales-2026-10-25.1.tsx.txt",
  },
  legal: {
    version: "2026-07-29.1",
    sha256: "c55e7cffefcf3ebc6e0807e3a234f8d155603e32344cd6ffc0f2478533538df9",
    effectiveDate: "29 juillet 2026",
    applicableUntil: PEPITE_LEGAL_EFFECTIVE_DATE,
    archive: "docs/legal-archives/legal-2026-07-29.1.tsx.txt",
  },
} as const;

export const LEGAL_DOCUMENTS = {
  legal: {
    version: "2026-10-26.1",
    sha256: "d781161fc310eed0195caeccc50e5ef8df4d7dd986f419134baceaf8738a3b46",
    effectiveDate: PEPITE_LEGAL_EFFECTIVE_DATE,
    path: "/legal",
  },
  terms: {
    version: "2026-10-26.1",
    sha256: "b7edb825c5e4e1626b85bfe09eeb746a557925b8739cda410665898c0de0d866",
    effectiveDate: PEPITE_TERMS_EFFECTIVE_DATE,
    path: "/conditions-generales",
  },
  privacy: {
    version: "2026-10-25.1",
    sha256: "f4eb47491d7ba15e83868156e2a084698d765166479c730b29c089a4f834bf60",
    effectiveDate: "25 octobre 2026",
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
