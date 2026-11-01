import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  courtRegistryDailyCap,
  courtRegistryFallbackEmails,
  COURT_REGISTRY_FALLBACK_DISCOVERY_METHOD,
  INFORMATION_AGENT_COURT_REGISTRY_FALLBACK,
  type CourtRegistryFallbackSale,
} from "@/lib/information-agent/court-registry-fallback";
import {
  isInformationAgentContactBlocked,
  loadInformationAgentContactRegistry,
  normalizedEmail,
  type InformationAgentContactCandidate,
} from "@/lib/information-agent/contacts";
import { formatInformationAgentOriginDate } from "@/lib/information-agent-compliance";

/**
 * Greffe de secours (lecture du référentiel `court_registry_contacts`, limites d'envoi). Seul module
 * serveur qui nomme la table (voir `scripts/check-security-invariants.mjs`). La règle pure (quelle
 * vente, quelles adresses) est dans `court-registry-fallback.ts`.
 *
 * L'agent n'écrit à un greffe que dans un cas : vente au tribunal reconnue, sans aucun destinataire
 * avocat ou cabinet exploitable (annonce, registre, recherche automatique). Gardes ordinaires
 * conservées (interrupteur d'envoi, opposition, rebond, délai de 30 jours par adresse, aperçu
 * obligatoire, un seul message par vente) ; limites propres aux greffes : une sollicitation par
 * tribunal et par vente, et un plafond par tribunal et par jour (3 par défaut, réglable).
 */

export type CourtRegistryContact = {
  courtCode: string;
  name: string;
  emails: string[];
};

export type CourtRegistryFallbackSaleInput = CourtRegistryFallbackSale & { id: string };

/** Ligne du référentiel d'un tribunal, ou null s'il n'y est pas. Une erreur de base est propagée. */
export async function loadCourtRegistryContact(
  courtCode: string,
): Promise<CourtRegistryContact | null> {
  const { data, error } = await supabaseAdmin
    .from("court_registry_contacts")
    .select("court_code,name,emails")
    .eq("court_code", courtCode)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { courtCode: data.court_code, name: data.name, emails: data.emails ?? [] };
}

export type CourtRegistryFallback = {
  candidate: InformationAgentContactCandidate;
  court: { code: string; name: string };
};

/**
 * Greffe de secours de cette vente : la première adresse de SON tribunal que l'agent peut solliciter
 * (opposition et rebond permanent contrôlés pour la vente), ou null. Une erreur de lecture est
 * propagée : un contrôle indisponible ne vaut jamais autorisation.
 */
export async function findCourtRegistryFallback(
  sale: CourtRegistryFallbackSaleInput,
  now: Date = new Date(),
): Promise<CourtRegistryFallback | null> {
  const courtCode = sale.tribunal_code?.trim();
  if (!courtCode) return null;
  const contact = await loadCourtRegistryContact(courtCode);
  if (!contact) return null;
  const emails = courtRegistryFallbackEmails(sale, contact.emails);
  for (const email of emails) {
    const rows = await loadInformationAgentContactRegistry(email, sale.id);
    if (rows.some((row) => isInformationAgentContactBlocked(row, sale.id))) continue;
    return {
      court: { code: contact.courtCode, name: contact.name },
      candidate: {
        email,
        name: null,
        role: "source_contact",
        recipientKind: "source_contact",
        confidence: "medium",
        score: 60,
        provenance: [
          {
            kind: "court_registry",
            field: "court_registry_contacts",
            sourceName: contact.name,
            sourceUrl: null,
          },
        ],
        source: {
          kind: INFORMATION_AGENT_COURT_REGISTRY_FALLBACK,
          url: null,
          observedAt: now.toISOString(),
          observedBy: "agent",
        },
      },
    };
  }
  return null;
}

/** Trace du greffe dans `information_agent_missions.metadata` (journal, administration, plafonds). */
export function courtRegistryFallbackMetadata(court: { code: string; name: string }) {
  return {
    address_origin: INFORMATION_AGENT_COURT_REGISTRY_FALLBACK,
    court_registry_fallback: { court_code: court.code, court_name: court.name },
  };
}

/**
 * Tribunal d'une mission adressée à son greffe, si `recipientEmail` est bien l'adresse de greffe
 * retenue pour ce brouillon. Un destinataire modifié par l'administrateur suit la voie ordinaire
 * (l'exclusion des adresses de juridiction s'applique alors).
 */
export function courtRegistryFallbackOfMission(
  mission: { metadata: unknown; recipient_email: string },
  recipientEmail: string,
): { courtCode: string; courtName: string | null } | null {
  const metadata = (mission.metadata ?? {}) as {
    contact_discovery?: { method?: unknown };
    court_registry_fallback?: { court_code?: unknown; court_name?: unknown };
  };
  const code = metadata.court_registry_fallback?.court_code;
  if (
    metadata.contact_discovery?.method !== COURT_REGISTRY_FALLBACK_DISCOVERY_METHOD ||
    typeof code !== "string" ||
    !code ||
    normalizedEmail(mission.recipient_email) !== normalizedEmail(recipientEmail)
  ) {
    return null;
  }
  const name = metadata.court_registry_fallback?.court_name;
  return { courtCode: code, courtName: typeof name === "string" ? name : null };
}

export const COURT_REGISTRY_ADDRESS_CHANGED_MESSAGE =
  "Cette adresse n’est plus celle du greffe indiquée par le référentiel des tribunaux : annulez ce brouillon et relancez la préparation.";

/** L'adresse figure toujours dans le référentiel pour ce tribunal (relue à l'aperçu et à l'envoi). */
export async function assertCourtRegistryFallbackAddress(
  courtCode: string,
  email: string,
): Promise<void> {
  const normalized = normalizedEmail(email);
  const contact = await loadCourtRegistryContact(courtCode);
  if (!normalized || !contact?.emails.some((item) => normalizedEmail(item) === normalized)) {
    throw new Error(COURT_REGISTRY_ADDRESS_CHANGED_MESSAGE);
  }
}

// ---------------------------------------------------------------------------
// Limites propres aux greffes
// ---------------------------------------------------------------------------
const BLOCKING_MISSION_STATUSES = ["approved", "sending", "sent", "replied", "completed"] as const;

/**
 * Début du jour (heure de Paris) qui contient `now`. Le plafond quotidien suit le jour calendaire
 * français, pas une fenêtre glissante de 24 heures.
 */
export function startOfParisDay(now: Date): Date {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  const localAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
  const offsetMs = localAsUtc - Math.floor(now.getTime() / 1000) * 1000;
  return new Date(Date.UTC(part("year"), part("month") - 1, part("day")) - offsetMs);
}

/**
 * Deux limites propres aux greffes, en plus du délai de 30 jours par adresse :
 *  - au plus une sollicitation par tribunal et par vente (même si le tribunal a plusieurs adresses) ;
 *  - au plus `INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP` sollicitations par tribunal et par jour
 *    (heure de Paris), 3 par défaut.
 * Comptent les missions approuvées et non échouées, et celles dont l'envoi est « à vérifier ». Avec
 * `approvedAt` (contrôle après approbation) seules les approbations plus anciennes comptent : les
 * approbations concurrentes se départagent, la plus ancienne passe.
 */
export async function assertCourtRegistryFallbackLimits({
  courtCode,
  saleId,
  missionId,
  approvedAt,
  now = new Date(),
  env = process.env,
}: {
  courtCode: string;
  saleId: string | null;
  missionId?: string | null;
  approvedAt?: string | null;
  now?: Date;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<void> {
  const cap = courtRegistryDailyCap(env);
  const dayStart = startOfParisDay(now).toISOString();
  const missions = (unverifiedSend: boolean, scope: "sale" | "day") => {
    const base = supabaseAdmin
      .from("information_agent_missions")
      .select("id,approved_at")
      .eq("metadata->court_registry_fallback->>court_code", courtCode);
    let query = unverifiedSend
      ? base.eq("status", "failed").eq("metadata->>send_outcome", "unverified")
      : base.in("status", [...BLOCKING_MISSION_STATUSES]);
    if (scope === "sale") query = query.eq("sale_id", saleId ?? "");
    else query = query.gte("approved_at", dayStart);
    if (missionId) query = query.neq("id", missionId);
    if (approvedAt) query = query.lte("approved_at", approvedAt);
    return query.limit(Math.max(cap, 1) + 1);
  };
  const [saleSent, saleUnverified, daySent, dayUnverified] = await Promise.all([
    saleId ? missions(false, "sale") : Promise.resolve({ data: [], error: null }),
    saleId ? missions(true, "sale") : Promise.resolve({ data: [], error: null }),
    missions(false, "day"),
    missions(true, "day"),
  ]);
  for (const { error } of [saleSent, saleUnverified, daySent, dayUnverified]) {
    if (error) throw error;
  }
  const forSale = [...(saleSent.data ?? []), ...(saleUnverified.data ?? [])];
  if (forSale.length > 0) {
    const on = formatInformationAgentOriginDate(forSale[0]?.approved_at ?? null);
    throw new Error(
      `Ce tribunal a déjà été sollicité pour cette vente${on ? ` le ${on}` : ""} : une seule demande est autorisée par tribunal et par vente.`,
    );
  }
  const today = [...(daySent.data ?? []), ...(dayUnverified.data ?? [])];
  if (today.length >= cap) {
    throw new Error(
      `Plafond atteint : ${cap} demande${cap > 1 ? "s" : ""} aux greffes par tribunal et par jour (INFORMATION_AGENT_COURT_REGISTRY_DAILY_CAP). Ce tribunal a déjà été sollicité ${today.length} fois aujourd’hui ; réessayez demain.`,
    );
  }
}
