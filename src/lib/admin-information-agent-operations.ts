import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildInformationAgentOperationsView,
  type InformationAgentIndicatorsRaw,
  type InformationAgentOperationsView,
} from "@/lib/information-agent/operations-view";
import { assertAdminAuth } from "@/lib/admin-auth.server";

export async function getAdminInformationAgentOperations(
  authToken: string,
  now = new Date(),
): Promise<InformationAgentOperationsView> {
  await assertAdminAuth(authToken);
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const [indicators, operations] = await Promise.all([
    supabaseAdmin.rpc("information_agent_indicators", {
      p_since: since,
      p_now: now.toISOString(),
    }),
    supabaseAdmin
      .from("information_agent_operations")
      .select("inbound_roundtrip_verified_at")
      .eq("singleton", true)
      .maybeSingle(),
  ]);
  if (indicators.error) throw indicators.error;
  if (operations.error) throw operations.error;
  return buildInformationAgentOperationsView(
    indicators.data as unknown as InformationAgentIndicatorsRaw,
    operations.data?.inbound_roundtrip_verified_at ?? null,
    now,
  );
}

/** « J'ai vérifié l'aller-retour réel » : enregistre la date, utilisée par le contrôle du pilote (lot 2). */
export async function attestAdminInformationAgentRoundtrip(
  authToken: string,
): Promise<InformationAgentOperationsView> {
  const auth = await assertAdminAuth(authToken);
  const { error } = await supabaseAdmin.rpc("attest_information_agent_roundtrip", {
    p_admin_id: auth.userId,
  });
  if (error) throw error;
  return getAdminInformationAgentOperations(authToken);
}
