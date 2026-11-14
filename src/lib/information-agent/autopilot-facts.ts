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
  /** Plus ancien `created_at` du contact au registre (toutes portées) : date du premier relevé (art. 14). Nul : absent. */
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

/** Envois et réponses précédents à cette adresse ou à cette identité (dossiers et missions). */
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
  const [cases, missions] = await Promise.all([
    supabaseAdmin
      .from("information_agent_cases")
      .select("sent_at,replied_at")
      .eq("normalized_recipient_email", email)
      .not("sent_at", "is", null)
      .limit(50),
    identityKeys.length
      ? supabaseAdmin
          .from("information_agent_missions")
          .select("sent_at,replied_at")
          .overlaps("recipient_identity_keys", [...identityKeys])
          .not("sent_at", "is", null)
          .limit(50)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (cases.error) throw cases.error;
  if (missions.error) throw missions.error;
  const rows = [...(cases.data ?? []), ...(missions.data ?? [])];
  const sixMonthsAgo = now.getTime() - 183 * DAY_MS;
  const sentAt = rows.map((row) => Date.parse(row.sent_at ?? "")).filter(Number.isFinite);
  const replies = rows.map((row) => Date.parse(row.replied_at ?? "")).filter(Number.isFinite);
  const iso = (time: number) => new Date(time).toISOString();
  return {
    alreadyInformed: rows.length > 0,
    lastReplyAt: replies.length ? iso(Math.max(...replies)) : null,
    silentSendsInSixMonths: rows.filter(
      (row) => !row.replied_at && Date.parse(row.sent_at ?? "") >= sixMonthsAgo,
    ).length,
    lastSendAt: sentAt.length ? iso(Math.max(...sentAt)) : null,
  };
}
