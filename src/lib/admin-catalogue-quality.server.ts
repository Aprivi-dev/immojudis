import "server-only";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildAdminCatalogueQualityView,
  CATALOGUE_QUALITY_ALERT_PREFIX,
  CATALOGUE_QUALITY_SOURCE_NAME,
  type AdminCatalogueQualityView,
} from "@/lib/admin-catalogue-quality";

/**
 * Contrôles qualité du catalogue pour /admin/quality : dernier cliché `catalogue-quality` et alertes
 * `catalogue.quality.*` ouvertes. Même protection que la supervision du pipeline (/api/admin/pipeline, qui lit
 * les mêmes tables) : jeton vérifié, rôle administrateur et double authentification, puis client de service,
 * en lecture seule. Le détail des alertes ne porte que des nombres et des identifiants de vente.
 */
export async function getAdminCatalogueQuality(
  authToken: string,
  now = new Date(),
): Promise<AdminCatalogueQualityView> {
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

  const [snapshotResult, alertsResult] = await Promise.all([
    supabaseAdmin
      .from("auction_pipeline_observations")
      .select("observed_at,metrics")
      .eq("source_name", CATALOGUE_QUALITY_SOURCE_NAME)
      .order("observed_at", { ascending: false })
      .limit(1),
    supabaseAdmin
      .from("operational_alerts")
      .select("alert_key,first_seen_at,last_seen_at,details")
      .like("alert_key", `${CATALOGUE_QUALITY_ALERT_PREFIX}%`)
      .eq("status", "open")
      .order("last_seen_at", { ascending: false }),
  ]);
  if (snapshotResult.error) throw snapshotResult.error;
  if (alertsResult.error) throw alertsResult.error;

  return buildAdminCatalogueQualityView(
    snapshotResult.data?.[0] ?? null,
    alertsResult.data ?? [],
    now,
  );
}
