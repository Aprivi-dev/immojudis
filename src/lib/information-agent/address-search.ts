import "server-only";
import type { Json } from "@/integrations/supabase/types";
import { adminDeadlineSignal } from "@/lib/admin-route-deadline";
import {
  findReusableInformationAgentAddress,
  type ReusableAddress,
} from "@/lib/information-agent/address-reuse";
import {
  isInformationAgentExcludedAddress,
  isInformationAgentExcludedSourceUrl,
} from "@/lib/information-agent/excluded-addresses";
import {
  INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE,
  loadInformationAgentContactRegistry,
  loadOpposedInformationAgentIdentityKeys,
  normalizedEmail,
  type InformationAgentContactCandidate,
  type InformationAgentContactSale,
} from "@/lib/information-agent/contacts";
import { firmSiteStartUrls } from "@/lib/information-agent/firm-site-extract";
import {
  informationAgentSearchUserAgent,
  searchFirmWebsiteAddress,
  type FirmSiteSearchDeps,
  type FirmSiteSearchStatus,
} from "@/lib/information-agent/firm-site-search";
import { INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS } from "@/lib/information-agent-compliance";
import { informationAgentIdentityKeys } from "@/lib/information-agent/identity";
import { assertInformationAgentRecipientCooldown } from "@/lib/information-agent/recipient-cooldown";

/**
 * Recherche autonome de l'adresse du professionnel d'une vente (niveau 1), quand l'annonce n'en
 * donne aucune qui soit exploitable. Deux sources, dans cet ordre :
 *   A. `other_listing` : adresse déjà publiée par le même professionnel (même nom, même
 *      téléphone) sur une autre annonce de moins de 6 mois ;
 *   B. `firm_website` : site du cabinet ou de l'étude cité par l'annonce.
 *
 * La recherche ne fait que préparer : elle propose une adresse avec son origine, que l'administrateur
 * relit dans l'aperçu avant de valider l'envoi. Elle ne sollicite jamais personne.
 *
 * Gardes : opposition par identité vérifiée AVANT toute lecture ou requête réseau ; opposition par
 * adresse, exclusions (juridiction, RPVA, Ordre, CARPA, noreply…) et délai de 30 jours revérifiés
 * pour l'adresse trouvée. Toute erreur de contrôle écarte l'adresse (jamais d'autorisation par défaut).
 */

export const INFORMATION_AGENT_ADDRESS_SEARCH_BUDGET_MS = 15_000;
/** Au plus deux sites sont essayés (une annonce cite rarement plus d'un site de cabinet). */
export const INFORMATION_AGENT_ADDRESS_SEARCH_MAX_SITES = 2;
/** Début du message de `assertInformationAgentRecipientCooldown` (couplage vérifié par un test). */
export const RECIPIENT_COOLDOWN_MESSAGE_PREFIX = "Ce destinataire a déjà été sollicité";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export type InformationAgentAddressSearchMethod = "other_listing" | "firm_website";

export type InformationAgentAddressSearchAttempt = {
  method: InformationAgentAddressSearchMethod;
  outcome:
    | "found"
    | "none"
    | "ambiguous"
    | "refused"
    | "blocked"
    | "unreachable"
    | "bounced"
    | "error";
  /** Détail sans donnée de page : motif de A, domaine et pages lues pour B. */
  detail?: string;
  host?: string;
  pages?: number;
};

export type InformationAgentAddressSearchOutcome =
  | {
      status: "found";
      method: InformationAgentAddressSearchMethod;
      candidate: InformationAgentContactCandidate;
      attempts: InformationAgentAddressSearchAttempt[];
    }
  | {
      status: "opposed";
      scope: "identity" | "address";
      attempts: InformationAgentAddressSearchAttempt[];
    }
  | {
      status: "cooldown";
      method: InformationAgentAddressSearchMethod;
      attempts: InformationAgentAddressSearchAttempt[];
    }
  | { status: "none"; attempts: InformationAgentAddressSearchAttempt[] };

export type InformationAgentAddressSearchSale = Pick<
  InformationAgentContactSale,
  | "id"
  | "lawyer_name"
  | "lawyer_contact"
  | "source_blocks"
  | "source_blocks_by_source"
  | "source_url"
  | "source_urls"
>;

type Verdict = "ok" | "opposed" | "opposed_identity" | "bounced" | "cooldown" | "excluded";

const FIRM_SITE_OUTCOMES: Partial<
  Record<FirmSiteSearchStatus, InformationAgentAddressSearchAttempt["outcome"]>
> = {
  none: "none",
  ambiguous: "ambiguous",
  robots_disallowed: "refused",
  robots_unreadable: "refused",
  blocked: "blocked",
  unreachable: "unreachable",
  budget: "unreachable",
  invalid_url: "refused",
};

export async function searchInformationAgentAddress({
  sale,
  identityPlace,
  siteOrigin,
  now = new Date(),
  budgetMs = INFORMATION_AGENT_ADDRESS_SEARCH_BUDGET_MS,
  deps,
}: {
  sale: InformationAgentAddressSearchSale;
  identityPlace: { bar: string | null; city: string | null };
  /** Origine publique d'Immojudis, reprise dans le user-agent. */
  siteOrigin: string;
  now?: Date;
  budgetMs?: number;
  deps?: FirmSiteSearchDeps;
}): Promise<InformationAgentAddressSearchOutcome> {
  const attempts: InformationAgentAddressSearchAttempt[] = [];
  const startedAt = (deps?.now ?? Date.now)();
  const signal = adminDeadlineSignal();
  const lawyerName = sale.lawyer_name?.trim() || null;
  const recipientKeys = informationAgentIdentityKeys({
    role: "lawyer",
    name: lawyerName,
    ...identityPlace,
  });

  // Sans clé d'identité (nom complet ou lieu manquant), l'opposition par identité ne peut pas être
  // contrôlée : ni la lecture des annonces ni le site ne sont consultés.
  if (!recipientKeys.length) {
    for (const method of ["other_listing", "firm_website"] as const) {
      attempts.push({ method, outcome: "refused", detail: "no_identity_keys" });
    }
    return { status: "none", attempts };
  }

  // Opposition par identité AVANT toute lecture ou requête réseau. Sans rôle sûr, tous les rôles
  // sont contrôlés : mieux vaut un blocage de trop qu'un professionnel opposé recontacté.
  try {
    const opposed = await loadOpposedInformationAgentIdentityKeys(
      informationAgentIdentityKeys({ role: null, name: lawyerName, ...identityPlace }),
    );
    if (opposed.length) return { status: "opposed", scope: "identity", attempts };
  } catch {
    attempts.push({ method: "other_listing", outcome: "error", detail: "opposition_check" });
    return { status: "none", attempts };
  }

  async function verdictFor(email: string, extraKeys: readonly string[]): Promise<Verdict> {
    const rows = await loadInformationAgentContactRegistry(email, sale.id);
    const applies = (scope: string | null) => scope === null || scope === sale.id;
    if (rows.some((row) => applies(row.scope_sale_id) && row.opposition_status === "opposed")) {
      return "opposed";
    }
    const keys = [...recipientKeys, ...extraKeys];
    if ((await loadOpposedInformationAgentIdentityKeys(keys)).length) return "opposed_identity";
    if (rows.some((row) => applies(row.scope_sale_id) && row.bounce_status === "permanent")) {
      return "bounced";
    }
    try {
      await assertInformationAgentRecipientCooldown({ email, missionId: NIL_UUID, now });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(RECIPIENT_COOLDOWN_MESSAGE_PREFIX)) {
        return "cooldown";
      }
      throw error;
    }
    return "ok";
  }

  function candidateFor({
    method,
    email,
    url,
    sourceName,
    matchRule,
    score,
  }: {
    method: InformationAgentAddressSearchMethod;
    email: string;
    url: string;
    sourceName: string | null;
    matchRule: string;
    score: number;
  }): InformationAgentContactCandidate {
    return {
      email,
      name: lawyerName,
      role: "lawyer",
      recipientKind: "source_lawyer",
      confidence: "medium",
      score,
      provenance: [{ kind: "agent_search", field: method, sourceName, sourceUrl: url }],
      source: { kind: method, url, observedAt: now.toISOString(), observedBy: "agent" },
      identityKeys: recipientKeys,
      matchRule,
    };
  }

  async function evaluateReuse(address: ReusableAddress): Promise<{ outcome: Verdict }> {
    const email = normalizedEmail(address.email);
    if (!email || isInformationAgentExcludedAddress(email)) return { outcome: "excluded" };
    // Le nom imprimé par l'annonce d'origine compte aussi pour l'opposition par identité.
    const extraKeys = informationAgentIdentityKeys({
      role: "lawyer",
      name: address.listingLawyerName,
      ...identityPlace,
    });
    return { outcome: await verdictFor(email, extraKeys) };
  }

  // A. Adresse déjà publiée par le même professionnel sur une autre annonce récente.
  try {
    const reuse = await findReusableInformationAgentAddress({
      saleId: sale.id,
      lawyerName,
      lawyerContact: sale.lawyer_contact,
      now,
      timeoutMs: budgetMs,
    });
    if (reuse.status !== "found") {
      attempts.push({
        method: "other_listing",
        outcome: reuse.status === "ambiguous" ? "ambiguous" : "none",
        ...(reuse.status === "none" ? { detail: reuse.reason } : {}),
      });
    } else {
      const found = await evaluateReuse(reuse.address);
      if (found.outcome === "ok") {
        attempts.push({ method: "other_listing", outcome: "found" });
        return {
          status: "found",
          method: "other_listing",
          attempts,
          candidate: candidateFor({
            method: "other_listing",
            email: reuse.address.email,
            url: reuse.address.listing.sourceUrl,
            sourceName: reuse.address.listing.sourceName,
            matchRule: "same_name_and_phone",
            score: 80,
          }),
        };
      }
      attempts.push({
        method: "other_listing",
        outcome: found.outcome === "bounced" ? "bounced" : "refused",
        detail: found.outcome,
      });
      // Opposition ou délai de 30 jours : le professionnel est identifié, on ne cherche pas sous
      // une autre adresse (ce serait contourner la garde).
      if (found.outcome === "opposed" || found.outcome === "opposed_identity") {
        return {
          status: "opposed",
          scope: found.outcome === "opposed" ? "address" : "identity",
          attempts,
        };
      }
      if (found.outcome === "cooldown") {
        return { status: "cooldown", method: "other_listing", attempts };
      }
    }
  } catch {
    attempts.push({ method: "other_listing", outcome: "error" });
  }

  // B. Site du cabinet ou de l'étude, cité par l'annonce.
  const startUrls = firmSiteStartUrls(sale).slice(0, INFORMATION_AGENT_ADDRESS_SEARCH_MAX_SITES);
  if (!startUrls.length) {
    attempts.push({ method: "firm_website", outcome: "none", detail: "no_site_in_listing" });
    return { status: "none", attempts };
  }
  const userAgent = informationAgentSearchUserAgent(siteOrigin);
  for (const startUrl of startUrls) {
    const left = budgetMs - ((deps?.now ?? Date.now)() - startedAt);
    if (left <= 0 || signal?.aborted) {
      attempts.push({ method: "firm_website", outcome: "unreachable", detail: "budget" });
      break;
    }
    try {
      const search = await searchFirmWebsiteAddress({
        startUrl,
        lawyerName,
        userAgent,
        budgetMs: left,
        signal,
        deps,
      });
      const email = search.status === "found" ? normalizedEmail(search.email) : null;
      if (search.status !== "found" || !email || !search.pageUrl) {
        attempts.push({
          method: "firm_website",
          outcome: FIRM_SITE_OUTCOMES[search.status] ?? "none",
          detail: search.status,
          host: search.host ?? undefined,
          pages: search.pagesFetched,
        });
        continue;
      }
      if (
        isInformationAgentExcludedAddress(email) ||
        isInformationAgentExcludedSourceUrl(search.pageUrl)
      ) {
        attempts.push({ method: "firm_website", outcome: "refused", detail: "excluded" });
        continue;
      }
      const verdict = await verdictFor(email, []);
      attempts.push({
        method: "firm_website",
        outcome: verdict === "ok" ? "found" : verdict === "bounced" ? "bounced" : "refused",
        detail: verdict === "ok" ? search.reason : verdict,
        host: search.host ?? undefined,
        pages: search.pagesFetched,
      });
      if (verdict === "opposed" || verdict === "opposed_identity") {
        return {
          status: "opposed",
          scope: verdict === "opposed" ? "address" : "identity",
          attempts,
        };
      }
      if (verdict === "cooldown") return { status: "cooldown", method: "firm_website", attempts };
      if (verdict === "bounced" || verdict === "excluded") continue;
      return {
        status: "found",
        method: "firm_website",
        attempts,
        candidate: candidateFor({
          method: "firm_website",
          email,
          url: search.pageUrl,
          sourceName: null,
          matchRule: `firm_site_${search.reason ?? "single"}`,
          score: 70,
        }),
      };
    } catch {
      attempts.push({ method: "firm_website", outcome: "error" });
    }
  }
  return { status: "none", attempts };
}

/**
 * Interrupteur de la recherche automatique d'adresse : coupée sauf valeur exactement `true`. Elle ne
 * doit être activée qu'après validation de la mise en balance et de l'analyse de seuil d'AIPD,
 * publication de `/agent-information` et mise à jour de la politique de confidentialité.
 */
export function isInformationAgentAddressSearchEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.INFORMATION_AGENT_ADDRESS_SEARCH_ENABLED === "true";
}

/** Seule l'origine de production consulte des sites tiers (jamais un aperçu ou un poste local). */
export const INFORMATION_AGENT_ADDRESS_SEARCH_ORIGINS: readonly string[] = [
  "https://immojudis.com",
  "https://www.immojudis.com",
];

export const ADDRESS_SEARCH_DISABLED_NOTE =
  " La recherche automatique d’adresse est désactivée : indiquez l’adresse et la page publique où vous l’avez relevée.";
export const ADDRESS_SEARCH_NOT_PRODUCTION_NOTE =
  " La recherche automatique d’adresse n’est active que sur le site de production : indiquez l’adresse et la page publique où vous l’avez relevée.";
export const ADDRESS_SEARCH_SEND_REFUSED_MESSAGE =
  "La recherche automatique d’adresse est désactivée : cette adresse ne peut pas être utilisée pour un envoi.";

/**
 * Une adresse trouvée par l'agent (source autre que l'annonce de la vente ou une saisie
 * d'administrateur) ne sert à aucun envoi tant que la recherche automatique est coupée.
 */
export function assertInformationAgentSearchedAddressAllowed(
  origin: { automated: boolean },
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  if (origin.automated && !isInformationAgentAddressSearchEnabled(env)) {
    throw new Error(ADDRESS_SEARCH_SEND_REFUSED_MESSAGE);
  }
}

export const ADDRESS_NOT_RECORDED_MESSAGE =
  "L’adresse retrouvée n’a pas pu être enregistrée : le brouillon a été annulé, réessayez.";
export const AGENT_FOUND_ORIGIN_MISSING_MESSAGE =
  "L’adresse retrouvée par la recherche automatique n’a plus de ligne de registre de l’agent : l’origine saisie à la main n’est pas admise, annulez ce brouillon et relancez la préparation.";

/**
 * Vrai quand le destinataire est celui que la recherche automatique a retrouvé pour ce brouillon
 * (`metadata.contact_discovery.method` commence par `agent_search_`). Un destinataire modifié par
 * l'administrateur suit la voie ordinaire (page publique saisie).
 */
export function isAgentFoundRecipient(
  mission: { metadata: unknown; recipient_email: string },
  recipientEmail: string,
): boolean {
  const method = (mission.metadata as { contact_discovery?: { method?: unknown } } | null)
    ?.contact_discovery?.method;
  return (
    typeof method === "string" &&
    method.startsWith("agent_search_") &&
    normalizedEmail(mission.recipient_email) === normalizedEmail(recipientEmail)
  );
}

/**
 * Une adresse retrouvée par l'agent exige sa ligne de registre (`observed_by = agent`, autre annonce
 * ou site du cabinet) : sans elle, ni URL saisie à la main ni saisie d'administrateur ne la
 * « blanchissent » (libellé, mention de la recherche automatique et interrupteur contournés).
 */
export function assertAgentFoundOriginIntact(
  agentFound: boolean,
  origin: { kind: string | null; origin: { automated: boolean } },
): void {
  if (agentFound && !(origin.origin.automated && origin.kind !== "admin_entry")) {
    throw new Error(AGENT_FOUND_ORIGIN_MISSING_MESSAGE);
  }
}

export type InformationAgentDraftAddressSearch = {
  /** Adresse proposée, à relire dans l'aperçu ; null si rien de sûr n'a été retrouvé. */
  candidate: InformationAgentContactCandidate | null;
  /** `agent_search_other_listing` ou `agent_search_firm_website` quand une adresse est proposée. */
  discoveryMethod: string | null;
  /** Trace enregistrée dans la mission : sources essayées et résultat, jamais le contenu d'une page. */
  snapshot: Json | null;
  /** Suite du message d'erreur « renseignez l'adresse » quand la recherche n'a rien trouvé. */
  noAddressNote: string;
};

function noAddressNote(outcome: InformationAgentAddressSearchOutcome): string {
  const details = outcome.attempts.map((attempt) => attempt.detail);
  if (details.includes("opposition_check")) {
    return " La recherche automatique n’a pas pu être effectuée : le contrôle d’opposition est indisponible. Réessayez plus tard ou saisissez l’adresse.";
  }
  if (details.includes("no_identity_keys")) {
    return " La recherche automatique n’a pas été effectuée : le nom complet du professionnel ou le lieu de la vente manque pour contrôler l’opposition.";
  }
  return " La recherche automatique (autre annonce du même professionnel, site du cabinet cité par l’annonce) n’a retrouvé aucune adresse sûre.";
}

/**
 * Recherche pour la préparation d'un brouillon. `skip` : l'annonce donne déjà une adresse ou
 * l'administrateur en a saisi une, aucune recherche n'a lieu. L'interrupteur et l'origine de
 * production sont contrôlés avant toute lecture ou requête, pour les deux sources. Un professionnel
 * opposé ou une adresse déjà sollicitée dans les 30 derniers jours interrompt la préparation.
 */
export async function searchInformationAgentAddressForDraft({
  skip,
  env = process.env,
  ...input
}: Parameters<typeof searchInformationAgentAddress>[0] & {
  skip: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<InformationAgentDraftAddressSearch> {
  const none = (note: string): InformationAgentDraftAddressSearch => ({
    candidate: null,
    discoveryMethod: null,
    snapshot: null,
    noAddressNote: note,
  });
  if (skip) return none("");
  if (!isInformationAgentAddressSearchEnabled(env)) return none(ADDRESS_SEARCH_DISABLED_NOTE);
  const origin = URL.canParse(input.siteOrigin) ? new URL(input.siteOrigin).origin : "";
  if (!INFORMATION_AGENT_ADDRESS_SEARCH_ORIGINS.includes(origin)) {
    return none(ADDRESS_SEARCH_NOT_PRODUCTION_NOTE);
  }
  const outcome = await searchInformationAgentAddress(input);
  if (outcome.status === "opposed") {
    throw new Error(
      outcome.scope === "identity"
        ? INFORMATION_AGENT_IDENTITY_OPPOSED_MESSAGE
        : "L’adresse retrouvée par la recherche automatique est opposée : aucune sollicitation n’est autorisée.",
    );
  }
  if (outcome.status === "cooldown") {
    throw new Error(
      `L’adresse retrouvée par la recherche automatique a déjà été sollicitée au cours des ${INFORMATION_AGENT_RECIPIENT_COOLDOWN_DAYS} derniers jours : aucun nouveau message n’est préparé.`,
    );
  }
  return {
    candidate: outcome.status === "found" ? outcome.candidate : null,
    discoveryMethod: outcome.status === "found" ? `agent_search_${outcome.method}` : null,
    snapshot: {
      status: outcome.status,
      attempts: outcome.attempts.map((attempt) => ({
        method: attempt.method,
        outcome: attempt.outcome,
        detail: attempt.detail ?? null,
        host: attempt.host ?? null,
        pages: attempt.pages ?? null,
      })),
    },
    noAddressNote: outcome.status === "found" ? "" : noAddressNote(outcome),
  };
}
