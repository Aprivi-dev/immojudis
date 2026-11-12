import { normalizedEmail } from "@/lib/information-agent/email-address";
import { informationAgentExcludedAddressReason } from "@/lib/information-agent/excluded-addresses";

/**
 * Contact de SECOURS d'une vente au tribunal : l'adresse du greffe du référentiel
 * (`court_registry_contacts`), quand l'annonce ne donne aucun destinataire avocat ou cabinet
 * exploitable. Module pur (aucun accès base ni réseau), importable partout ; la lecture du
 * référentiel et les limites sont dans `court-registry.ts` (serveur).
 *
 * Miroir Python : `services/data-pipeline/src/information_sufficiency.py` (`is_court_sale`,
 * `court_registry_fallback_emails`) qui donne la preuve `court_email` du minimum d'une annonce.
 * Cas partagés : `services/data-pipeline/tests/fixtures/court_registry_fallback_cases.json`,
 * exécutés par pytest et par vitest (`information-agent-court-registry-parity.test.ts`).
 */

/**
 * Origine de l'adresse d'un greffe (`information_agent_contacts.source_kind`), distincte de toute autre ; aussi
 * la valeur de `metadata.contact_discovery.method` d'une mission adressée au greffe.
 */
export const INFORMATION_AGENT_COURT_REGISTRY_FALLBACK = "court_registry_fallback";

/** Sources qui ne sont jamais une vente au tribunal : notaires, cessions de l'État, AGRASC. */
const EXCLUDED_SOURCES: ReadonlySet<string> = new Set(["notaires", "cessions_etat", "agrasc"]);
/** Vente au tribunal CONFIRMÉE par l'annonce : un tribunal seulement déduit de l'adresse ne suffit pas. */
const VERIFIED_STATUSES: ReadonlySet<string> = new Set(["verified", "cross_checked"]);
/** Le tribunal nommé par la source contredit celui du code INSEE : pas de contact de secours. */
const INCONSISTENT_COURT_FLAG = "tribunal_inconsistent";

export type CourtRegistryFallbackSale = {
  sale_venue_type?: string | null;
  sale_verification_status?: string | null;
  source_name?: string | null;
  primary_source?: string | null;
  tribunal_code?: string | null;
  quality_flags?: unknown;
};

function lowerTrim(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Vente au tribunal (saisie immobilière ou autre vente judiciaire) confirmée par l'annonce. Jamais
 * une vente de notaire, une cession de l'État ni l'AGRASC ; jamais un tribunal incohérent.
 */
export function isCourtRegistryFallbackSale(sale: CourtRegistryFallbackSale): boolean {
  if (sale.sale_venue_type !== "tribunal") return false;
  if (!VERIFIED_STATUSES.has(sale.sale_verification_status ?? "")) return false;
  if (
    EXCLUDED_SOURCES.has(lowerTrim(sale.source_name)) ||
    EXCLUDED_SOURCES.has(lowerTrim(sale.primary_source))
  ) {
    return false;
  }
  const flags = Array.isArray(sale.quality_flags) ? sale.quality_flags : [];
  return !flags.includes(INCONSISTENT_COURT_FLAG);
}

/**
 * Adresses du greffe de SON tribunal que l'agent peut solliciter pour cette vente, dans l'ordre du
 * référentiel. L'exclusion `court` ne s'applique pas à ces adresses (c'est leur raison d'être) ;
 * toute autre exclusion (RPVA, Ordre, CARPA, technique) et les adresses refusées (opposition,
 * rebond permanent : `blocked`) s'appliquent.
 */
export function courtRegistryFallbackEmails(
  sale: CourtRegistryFallbackSale,
  registryEmails: readonly string[],
  blocked: ReadonlySet<string> = new Set(),
): string[] {
  if (!isCourtRegistryFallbackSale(sale) || !sale.tribunal_code?.trim()) return [];
  const emails: string[] = [];
  for (const raw of registryEmails) {
    const email = normalizedEmail(raw);
    if (!email || emails.includes(email) || blocked.has(email)) continue;
    const reason = informationAgentExcludedAddressReason(email);
    if (reason !== null && reason !== "court") continue;
    emails.push(email);
  }
  return emails;
}

/** Plafond par défaut de sollicitations de greffes, par tribunal et par jour (valeur prudente). */
export const COURT_REGISTRY_DAILY_CAP_DEFAULT = 3;
/** Variable d'environnement qui règle le plafond quotidien par tribunal (0 : aucun envoi aux greffes). */
const COURT_REGISTRY_DAILY_CAP_ENV = "INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP";
const COURT_REGISTRY_DAILY_CAP_MAX = 100;

/**
 * Plafond quotidien par tribunal : entier de 0 à 100 dans `INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP`,
 * sinon la valeur par défaut. Une valeur illisible ne désactive jamais la limite.
 */
export function courtRegistryDailyCap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[COURT_REGISTRY_DAILY_CAP_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return COURT_REGISTRY_DAILY_CAP_DEFAULT;
  const value = Number(raw);
  return value <= COURT_REGISTRY_DAILY_CAP_MAX ? value : COURT_REGISTRY_DAILY_CAP_DEFAULT;
}
