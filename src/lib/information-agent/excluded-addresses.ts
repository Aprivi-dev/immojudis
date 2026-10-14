/**
 * Adresses que l'agent d'information ne sollicite jamais, quelle que soit leur origine (annonce,
 * annuaire, site du cabinet ou saisie d'un administrateur).
 *
 * - `court` : juridictions (greffe, accueil d'un tribunal), `@justice.fr` et `@*.justice.gouv.fr` ;
 * - `rpva` : adresses du réseau privé virtuel des avocats (`@avocat-conseil.fr`), canal réservé à
 *   la procédure ;
 * - `bar_or_carpa` : adresses de l'Ordre des avocats, du barreau, du bâtonnier et des CARPA ;
 * - `technical` : adresses `noreply`, `dpo` et `rgpd`, qui ne désignent aucun interlocuteur.
 *
 * Miroir Python : `services/data-pipeline/src/information_sufficiency.py`
 * (`excluded_contact_reason`). Cas partagés :
 * `services/data-pipeline/tests/fixtures/information_agent_contact_cases.json`.
 */
export type InformationAgentExcludedAddressReason = "court" | "rpva" | "bar_or_carpa" | "technical";

const COURT_DOMAIN = /(?:^|\.)justice\.(?:fr|gouv\.fr)$/;
const RPVA_DOMAIN = /(?:^|\.)avocat-conseil\.fr$/;
/** Un libellé du domaine qui commence par ordre, barreau, bâtonnier ou carpa. */
const BAR_OR_CARPA_DOMAIN = /(?:^|[.-])(?:ordre|barreau|batonnat|batonnier|carpa)/;
const BAR_OR_CARPA_LOCAL = /^(?:ordre|barreau|batonnat|batonnier|carpa)(?:[._+-]|$)/;
const TECHNICAL_LOCAL = /^(?:no[._-]?reply|do[._-]?not[._-]?reply|dpo|rgpd)(?:[._+-]|$)/;

export function informationAgentExcludedAddressReason(
  email: string,
): InformationAgentExcludedAddressReason | null {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  const local = at >= 0 ? normalized.slice(0, at) : normalized;
  const domain = at >= 0 ? normalized.slice(at + 1) : "";
  if (COURT_DOMAIN.test(domain)) return "court";
  if (RPVA_DOMAIN.test(domain)) return "rpva";
  if (BAR_OR_CARPA_DOMAIN.test(domain) || BAR_OR_CARPA_LOCAL.test(local)) return "bar_or_carpa";
  if (TECHNICAL_LOCAL.test(local)) return "technical";
  return null;
}

export function isInformationAgentExcludedAddress(email: string): boolean {
  return informationAgentExcludedAddressReason(email) !== null;
}

/**
 * Adresse d'une juridiction (greffe, accueil du tribunal) : elle figure dans les annonces mais
 * n'est jamais l'interlocuteur de l'agent, qui ne sollicite ni tribunal ni greffe.
 */
export function isCourtRegistryEmail(email: string): boolean {
  return informationAgentExcludedAddressReason(email) === "court";
}

export const INFORMATION_AGENT_EXCLUDED_ADDRESS_MESSAGE =
  "Cette adresse (juridiction, messagerie RPVA, Ordre ou CARPA, adresse technique noreply, dpo ou rgpd) n’est jamais sollicitée par l’agent.";
