import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { INFORMATION_AGENT_PIPELINE_CHANNEL } from "@/lib/information-agent/contact-resolution";
import type { AutopilotCandidateFacts } from "@/lib/information-agent/autopilot-rules";

/**
 * Faits que le pilote lit en base, partagés par la sélection (`autopilot-candidates.ts`) et la revérification juste
 * avant l'envoi (`autopilot-send-guard.ts`) : une seule lecture des pauses, de l'origine et des dates de relevé.
 */
const DAY_MS = 86_400_000;

export type AutopilotRegistryFacts = {
  /**
   * Plus ancien `created_at` du contact au registre (toutes portées) : date du premier relevé (art. 14). Nul : absent.
   * RÈGLE LIÉE : le tri de la file la lit pour plusieurs adresses à la fois (`loadAutopilotFirstRecordedAt`).
   */
  firstRecordedAt: string | null;
  /** Dernière date de relevé (`observed_at`) du contact pour cette vente. Nulle : absente (refus). */
  observedAt: string | null;
  /** Origines enregistrées pour cette adresse sur cette vente (`source_kind`). */
  originKinds: string[];
  /** L'adresse vient du décodage Licitor du pipeline. */
  licitorDecoded: boolean;
};

export async function loadAutopilotRegistryFacts(
  email: string,
  saleId: string,
): Promise<AutopilotRegistryFacts> {
  // Deux lectures : le premier relevé de l'adresse, toutes ventes confondues (article 14), et les lignes de CETTE
  // vente, filtrées dans la requête avant la limite : pour un avocat relevé sur de nombreuses ventes, la date de
  // relevé de la vente courante n'est jamais coupée. Sans elle, `address_stale` refuse (aucun repli).
  const [first, sale] = await Promise.all([
    supabaseAdmin
      .from("information_agent_contacts")
      .select("created_at")
      .eq("normalized_email", email)
      .order("created_at", { ascending: true })
      .limit(1),
    supabaseAdmin
      .from("information_agent_contacts")
      .select("observed_at,source_kind,metadata")
      .eq("normalized_email", email)
      .eq("scope_sale_id", saleId)
      .limit(50),
  ]);
  if (first.error) throw first.error;
  if (sale.error) throw sale.error;
  const forSale = sale.data ?? [];
  const observed = forSale
    .map((row) => row.observed_at)
    .filter(
      (value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)),
    )
    .sort();
  return {
    firstRecordedAt: first.data?.[0]?.created_at ?? null,
    observedAt: observed[observed.length - 1] ?? null,
    originKinds: [...new Set(forSale.flatMap((row) => (row.source_kind ? [row.source_kind] : [])))],
    licitorDecoded: forSale.some((row) => {
      const metadata = row.metadata;
      return (
        Boolean(metadata) &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        (metadata as { observation_channel?: unknown }).observation_channel ===
          INFORMATION_AGENT_PIPELINE_CHANNEL
      );
    }),
  };
}

/**
 * « Déjà informé » veut dire « remis » (art. 14, relectures juridique et sécurité du 23/11/2026) : seul un envoi dont
 * le dossier ou la mission porte l'état `delivered` (évènement `email.delivered`) ou `complained` (une plainte suppose
 * un message remis) dans `metadata.delivery` (`information-agent-inbound/case-delivery.ts`). Un rebond, un échec ou
 * l'absence d'état (envoi antérieur à cette marque, évènement jamais reçu) ne prouve rien : non informé. Le journal
 * des envois (`email_send_log`) n'est pas lu : il est purgé après 90 jours et ne sert à aucune décision
 * (`email-delivery-log.test.ts`).
 */
const INFORMED_STATES: ReadonlySet<string> = new Set(["delivered", "complained"]);

/** L'envoi compte pour « déjà informé » : remis selon son dossier ou sa mission. */
export function sendInformedRecipient(deliveryStatus: string | null | undefined): boolean {
  return Boolean(deliveryStatus && INFORMED_STATES.has(deliveryStatus));
}

/**
 * Domaines dont un envoi n'informe aucun professionnel : adresses de test de Resend et domaines internes
 * (`information_agent_internal_domains`, dossier d'essai de l'aller-retour). Lecture seule ; une erreur remonte.
 */
async function loadNonProfessionalDomains(): Promise<ReadonlySet<string>> {
  const { data, error } = await supabaseAdmin
    .from("information_agent_internal_domains")
    .select("domain");
  if (error) throw error;
  return new Set(["resend.dev", ...(data ?? []).map((row) => row.domain)]);
}

/**
 * Chemin par identité : une mission compte si elle a été remise ET si son adresse n'est ni une adresse de test ni
 * une adresse interne (un essai envoyé à l'équipe sous la clé d'identité d'un avocat n'informe pas cet avocat).
 */
function missionInformedRecipient(
  row: { delivery_status: string | null; recipient_email: string | null },
  nonProfessional: ReadonlySet<string>,
): boolean {
  const domain = (row.recipient_email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return sendInformedRecipient(row.delivery_status) && !nonProfessional.has(domain);
}

/** Lignes lues au plus par lecture groupée du tri de la file (sous le plafond de lignes de l'API). */
const GROUPED_READ_LIMIT = 500;
/** Clés d'identité par lecture groupée des missions : borne la longueur de l'URL de la requête. */
const IDENTITY_KEYS_PER_READ = 100;

/**
 * Premier enregistrement de plusieurs adresses, en UNE lecture : même définition que `firstRecordedAt` de
 * `loadAutopilotRegistryFacts` (plus ancien `created_at` du contact au registre, toutes portées). Lignes triées de
 * la plus ancienne : la date rendue pour une adresse est toujours son minimum, même si la limite coupe la lecture.
 * Une adresse absente du résultat (inconnue du registre, ou coupée par la limite) est absente de la table rendue.
 */
export async function loadAutopilotFirstRecordedAt(
  emails: readonly string[],
): Promise<Map<string, string>> {
  const first = new Map<string, string>();
  if (!emails.length) return first;
  const { data, error } = await supabaseAdmin
    .from("information_agent_contacts")
    .select("normalized_email,created_at")
    .in("normalized_email", [...new Set(emails)])
    .order("created_at", { ascending: true })
    .limit(GROUPED_READ_LIMIT);
  if (error) throw error;
  for (const row of data ?? []) {
    if (row.normalized_email && !first.has(row.normalized_email)) {
      first.set(row.normalized_email, row.created_at);
    }
  }
  return first;
}

/**
 * Destinataires déjà informés, pour plusieurs à la fois : même définition que `alreadyInformed` de
 * `loadAutopilotHistoryFacts` (un dossier remis à l'adresse, ou une mission remise à l'une des clés d'identité hors
 * adresses de test et internes : `sendInformedRecipient`, `missionInformedRecipient`).
 * Rendu dans l'ordre des destinataires. Nul quand une lecture atteint sa limite : un envoi a pu échapper à la
 * lecture, et personne ne peut alors être dit « jamais informé ».
 */
export async function loadAutopilotAlreadyInformed(
  recipients: ReadonlyArray<{ email: string; identityKeys: readonly string[] }>,
): Promise<boolean[] | null> {
  if (!recipients.length) return [];
  const emails = [...new Set(recipients.map((recipient) => recipient.email))];
  const keys = [...new Set(recipients.flatMap((recipient) => recipient.identityKeys))];
  const keyChunks: string[][] = [];
  for (let start = 0; start < keys.length; start += IDENTITY_KEYS_PER_READ) {
    keyChunks.push(keys.slice(start, start + IDENTITY_KEYS_PER_READ));
  }
  const [nonProfessional, cases, ...missions] = await Promise.all([
    keys.length ? loadNonProfessionalDomains() : Promise.resolve(new Set<string>()),
    supabaseAdmin
      .from("information_agent_cases")
      .select("normalized_recipient_email,delivery_status:metadata->delivery->>status")
      .in("normalized_recipient_email", emails)
      .not("sent_at", "is", null)
      .limit(GROUPED_READ_LIMIT),
    ...keyChunks.map((chunk) =>
      supabaseAdmin
        .from("information_agent_missions")
        .select(
          "recipient_identity_keys,recipient_email,delivery_status:metadata->delivery->>status",
        )
        .overlaps("recipient_identity_keys", chunk)
        .not("sent_at", "is", null)
        .limit(GROUPED_READ_LIMIT),
    ),
  ]);
  if (cases.error) throw cases.error;
  for (const read of missions) if (read.error) throw read.error;
  const reads = [cases.data ?? [], ...missions.map((read) => read.data ?? [])];
  if (reads.some((rows) => rows.length >= GROUPED_READ_LIMIT)) return null;
  const sentEmails = new Set(
    (cases.data ?? [])
      .filter((row) => sendInformedRecipient(row.delivery_status))
      .map((row) => row.normalized_recipient_email),
  );
  const sentKeys = new Set(
    missions.flatMap((read) =>
      (read.data ?? [])
        .filter((row) => missionInformedRecipient(row, nonProfessional))
        .flatMap((row) => row.recipient_identity_keys),
    ),
  );
  return recipients.map(
    (recipient) =>
      sentEmails.has(recipient.email) || recipient.identityKeys.some((key) => sentKeys.has(key)),
  );
}

/**
 * Envois et réponses précédents à cette adresse ou à cette identité (dossiers et missions). RÈGLE LIÉE :
 * `alreadyInformed` est lu pour plusieurs destinataires à la fois par le tri de la file
 * (`loadAutopilotAlreadyInformed`).
 */
export async function loadAutopilotHistoryFacts(
  email: string,
  identityKeys: readonly string[],
  now: Date,
): Promise<
  Pick<
    AutopilotCandidateFacts,
    "alreadyInformed" | "lastReplyAt" | "silentSendsInSixMonths" | "lastSendAt"
  >
> {
  const [nonProfessional, cases, missions] = await Promise.all([
    identityKeys.length ? loadNonProfessionalDomains() : Promise.resolve(new Set<string>()),
    supabaseAdmin
      .from("information_agent_cases")
      .select("sent_at,replied_at,delivery_status:metadata->delivery->>status")
      .eq("normalized_recipient_email", email)
      .not("sent_at", "is", null)
      .limit(50),
    identityKeys.length
      ? supabaseAdmin
          .from("information_agent_missions")
          .select("sent_at,replied_at,recipient_email,delivery_status:metadata->delivery->>status")
          .overlaps("recipient_identity_keys", [...identityKeys])
          .not("sent_at", "is", null)
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (cases.error) throw cases.error;
  if (missions.error) throw missions.error;
  const caseRows = cases.data ?? [];
  const missionRows = missions.data ?? [];
  const rows = [...caseRows, ...missionRows];
  const sixMonthsAgo = now.getTime() - 183 * DAY_MS;
  const sentAt = rows.map((row) => Date.parse(row.sent_at ?? "")).filter(Number.isFinite);
  const replies = rows.map((row) => Date.parse(row.replied_at ?? "")).filter(Number.isFinite);
  const iso = (time: number) => new Date(time).toISOString();
  return {
    // Seuls les envois remis informent ; les pauses (réponse, silence, dernier envoi) comptent tous les envois.
    alreadyInformed:
      caseRows.some((row) => sendInformedRecipient(row.delivery_status)) ||
      missionRows.some((row) => missionInformedRecipient(row, nonProfessional)),
    lastReplyAt: replies.length ? iso(Math.max(...replies)) : null,
    silentSendsInSixMonths: rows.filter(
      (row) => !row.replied_at && Date.parse(row.sent_at ?? "") >= sixMonthsAgo,
    ).length,
    lastSendAt: sentAt.length ? iso(Math.max(...sentAt)) : null,
  };
}
