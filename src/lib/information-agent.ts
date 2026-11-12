import "server-only";
import { assertAdmin } from "@/lib/admin-auth.server";
import type { SupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { ADMIN_PAGE_SIZE, adminPageMeta } from "@/lib/admin-pagination";
import { loadDeliveryLog } from "@/lib/information-agent/delivery-log-reader";
import { missionDeliveryState } from "@/lib/information-agent/delivery-state";
import { recordManualMissionReply } from "@/lib/information-agent/manual-reply";
import {
  cancelMission,
  listFactsForCases,
  loadOwnedMission,
  missionFromRow,
} from "@/lib/information-agent/mission-store";
import { approveAndSendMission } from "@/lib/information-agent/send";
import type {
  InformationAgentAdminActionPayload,
  InformationAgentAdminListResponse,
  InformationAgentAdminMissionPage,
  InformationAgentSendTrigger,
} from "@/lib/information-agent/schemas";

// Liste des missions et routeur des actions administrateur de l'agent d'information. Le reste vit dans
// `information-agent/` : schemas.ts, draft.ts (brouillon), preview.ts (aperçu), send.ts (envoi),
// mission-store.ts (accès aux missions), config.ts (configuration d'envoi).

// Types encore importés d'ici par `src/components/admin/` et `src/lib/client-api/` (hors de ce lot).
export type {
  InformationAgentAdminActionPayload,
  InformationAgentAdminListResponse,
  InformationAgentAdminMissionPage,
  InformationAgentCreateInput,
  InformationAgentMission,
  InformationAgentPreviewInput,
} from "@/lib/information-agent/schemas";
export type { InformationAgentPrepareResponse } from "@/lib/information-agent/prepare";
export type { InformationAgentPreviewResponse } from "@/lib/information-agent/preview";

export async function listAdminInformationAgentMissions({
  auth,
  saleId,
  offset = 0,
  limit = ADMIN_PAGE_SIZE,
}: {
  auth: SupabaseAuthContext;
  saleId?: string;
  offset?: number;
  limit?: number;
}): Promise<InformationAgentAdminMissionPage> {
  assertAdmin(auth);
  let query = supabaseAdmin
    .from("information_agent_missions")
    .select("*", { count: "exact" })
    .eq("user_id", auth.userId)
    // L'id départage les missions créées dans la même milliseconde : pages stables.
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(offset, offset + limit - 1);
  if (saleId) query = query.eq("sale_id", saleId);

  const { data, error, count } = await query;
  if (error) throw error;
  const rows = data ?? [];
  const [saleTitles, deliveryLog] = await Promise.all([
    loadSaleTitles(rows.flatMap((mission) => (mission.sale_id ? [mission.sale_id] : []))),
    loadDeliveryLog(
      rows.flatMap((mission) => (mission.provider_message_id ? [mission.provider_message_id] : [])),
    ),
  ]);
  return {
    ok: true,
    missions: rows.map((row) => ({
      ...missionFromRow(row),
      saleTitle: row.sale_id ? (saleTitles.get(row.sale_id) ?? null) : null,
      deliveryState: missionDeliveryState(
        row,
        row.provider_message_id ? deliveryLog.get(row.provider_message_id) : undefined,
      ),
    })),
    facts: await listFactsForCases(
      rows.flatMap((mission) => (mission.case_id ? [mission.case_id] : [])),
    ),
    ...adminPageMeta({ offset, limit, total: count ?? offset + rows.length }),
  };
}

/**
 * Titres des ventes de la page de missions, pour que l'administrateur reconnaisse la vente sans
 * ouvrir chaque ligne. Réservé à la liste admin ; une lecture en échec laisse simplement les lignes
 * sans titre (jamais un échec de la liste).
 */
async function loadSaleTitles(saleIds: string[]): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  const uniqueIds = [...new Set(saleIds)];
  if (!uniqueIds.length) return titles;
  const { data, error } = await supabaseAdmin
    .from("auction_sales")
    .select("id,title")
    .in("id", uniqueIds);
  if (error) {
    console.warn("Titres des ventes de l'agent illisibles", { code: error.code ?? null });
    return titles;
  }
  for (const row of data ?? []) {
    if (typeof row.title === "string" && row.title.trim()) titles.set(row.id, row.title.trim());
  }
  return titles;
}

export async function runAdminInformationAgentAction({
  auth,
  input,
  fetchImpl = fetch,
  trigger,
}: {
  auth: SupabaseAuthContext;
  input: InformationAgentAdminActionPayload;
  fetchImpl?: typeof fetch;
  /** Interne : le pilote automatique (`information-agent-autopilot.ts`) ; absent pour un administrateur. */
  trigger?: InformationAgentSendTrigger;
}): Promise<InformationAgentAdminListResponse> {
  assertAdmin(auth);

  if (input.action === "approve_and_send") {
    await approveAndSendMission({ adminId: auth.userId, input, fetchImpl, trigger });
  } else if (input.action === "record_reply") {
    const replyMission = await loadOwnedMission(auth.userId, input.missionId);
    await recordManualMissionReply({ mission: replyMission, input });
  } else {
    await cancelMission({ adminId: auth.userId, missionId: input.missionId });
  }

  const mission = await loadOwnedMission(auth.userId, input.missionId);
  return {
    ok: true,
    missions: [missionFromRow(mission)],
    facts: await listFactsForCases(mission.case_id ? [mission.case_id] : []),
  };
}
