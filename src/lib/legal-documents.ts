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
export const PEPITE_TERMS_EFFECTIVE_DATE = "1er décembre 2026";
export const PEPITE_LEGAL_EFFECTIVE_DATE = "26 octobre 2026";

/**
 * Versions du 26/10/2026 liées au contrôle du risque d'inondation de la règle `pepite-v2` (coordonnées d'une
 * vente transmises à Géorisques et à l'API Carto de l'IGN, données publiques réutilisées). Elles ne touchent pas
 * aux CGU : la décision du fondateur est prise, les CGU restent intactes (version 2026-10-26.1) et aucun email
 * d'information n'est envoyé aux titulaires de compte pour ce lot (la politique de confidentialité et les mentions
 * légales entrent en vigueur à la mise en ligne, sans préavis).
 *
 * - Politique de confidentialité 2026-10-26.1 : ligne de traitement « Repère « Pépite » : contrôle du risque
 *   d'inondation d'une vente » et destinataires (BRGM, IGN) ; en vigueur à la mise en ligne, sans préavis.
 * - Mentions légales 2026-10-26.2 : paragraphe « Données publiques réutilisées » ; en vigueur à la mise en ligne,
 *   sans préavis.
 * Les dates d'effet ci-dessous sont celles de la rédaction : à décaler à la date réelle de mise en ligne si elle
 * diffère (elles n'entrent pas dans l'empreinte du texte).
 */
export const FLOOD_LEGAL_EFFECTIVE_DATE = "26 octobre 2026";

/**
 * Politique de confidentialité 2026-10-31.1 : complète le tableau des traitements (événements d'usage
 * par compte et clics des emails, retours « Utile / Pas pertinent », instantanés d'estimation) et
 * corrige « sans identifiant de personne », « noms remplacés par leur rôle » et les réglages Google
 * Analytics non vérifiés. Relecture `juridique-rgpd` à faire ; en vigueur à la mise en ligne, sans
 * préavis (aucun traitement nouveau, seulement une description plus complète). Date à décaler à la
 * date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_COMPLETION_EFFECTIVE_DATE = "31 octobre 2026";

/**
 * Politique de confidentialité 2026-11-01.1 : ajoute les demandes aux greffes (contact de secours d'une vente
 * au tribunal sans adresse d'avocat : au plus un message par vente et, par tribunal, au plus un plafond
 * quotidien configuré, base de l'intérêt légitime, opposition). La version 2026-10-31.1, en production depuis le
 * 01/11/2026 au matin, est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée
 * avec l'acceptation d'une inscription ou d'un achat, aucun contrôle n'impose de la ré-accepter. En vigueur
 * à la mise en ligne, sans préavis (information sur un traitement nouveau qui ne touche que des
 * destinataires institutionnels). Date à décaler à la date réelle de mise en ligne si elle diffère (elle
 * n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_COURT_REGISTRY_EFFECTIVE_DATE = "1er novembre 2026";

/**
 * Politique de confidentialité 2026-11-01.2 : ajoute le paragraphe d'information (art. 13) sur les messages
 * écrits à l'adresse de réponse de l'agent sans dossier ouvert (conservation de l'adresse, du nom, de l'objet,
 * de la date et d'un extrait ; intérêt légitime ; 12 mois si nous avions écrit, 21 jours sinon). La version
 * 2026-11-01.1 est archivée. Aucun consentement n'est redemandé : la version n'est qu'enregistrée avec
 * l'acceptation d'une inscription ou d'un achat, aucun contrôle n'impose de la ré-accepter. En vigueur à la
 * mise en ligne, sans préavis. Date à décaler à la date réelle de mise en ligne si elle diffère (elle
 * n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_UNROUTED_MESSAGES_EFFECTIVE_DATE = "1er novembre 2026";

/**
 * Politique de confidentialité 2026-11-01.3 : ajoute le journal des emails envoyés par Immojudis (ligne du
 * tableau des traitements : intérêt légitime, 90 jours, suppression avec le compte), Resend comme
 * sous-traitant (30 jours, États-Unis), les consultations tracées 6 mois, l'adresse et l'objet dans le journal
 * pour les professionnels contactés, et l'effacement du compte. La version 2026-11-01.2 est archivée. Aucun
 * consentement n'est redemandé : la version n'est qu'enregistrée avec l'acceptation d'une inscription ou d'un
 * achat, aucun contrôle n'impose de la ré-accepter. En vigueur à la mise en ligne, sans préavis. Date à décaler
 * à la date réelle de mise en ligne si elle diffère (elle n'entre pas dans l'empreinte du texte).
 */
export const PRIVACY_EMAIL_LOG_EFFECTIVE_DATE = "1er novembre 2026";

export const LEGAL_DOCUMENTS = {
  legal: {
    version: "2026-10-26.2",
    sha256: "dde9d6be17b0ad750cb04fbcca4b51555c90324e143b9605523004ccca674247",
    effectiveDate: FLOOD_LEGAL_EFFECTIVE_DATE,
    path: "/legal",
  },
  terms: {
    version: "2026-10-26.1",
    sha256: "745ef0eacc7edc8dd02a63e36f6a0f0f9a18b07eeef2644abec806d4b0fd83e0",
    effectiveDate: PEPITE_TERMS_EFFECTIVE_DATE,
    path: "/conditions-generales",
  },
  privacy: {
    version: "2026-11-01.3",
    sha256: "7bafa3d9a9cfed003fc49c50eb2759ceef8f8b6aa395e157538fe245b5cd6824",
    effectiveDate: PRIVACY_EMAIL_LOG_EFFECTIVE_DATE,
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
