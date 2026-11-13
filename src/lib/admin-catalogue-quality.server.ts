import "server-only";
import { assertAdminAuth } from "@/lib/admin-auth.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import {
  buildAdminCatalogueQualityView,
  buildCeilingCoverage,
  buildCrossSourceDuplicates,
  CATALOGUE_QUALITY_ALERT_PREFIX,
  CATALOGUE_QUALITY_SOURCE_NAME,
  type AdminCatalogueQualityView,
  type CeilingCoverageView,
  type CrossSourceDuplicatesPayload,
  type CrossSourceDuplicatesView,
} from "@/lib/admin-catalogue-quality";
import { readAdminCeilingCoverageSales } from "@/lib/admin-pepites";

/** Groupes à trois sources ou plus listés dans le panneau. */
const THREE_SOURCE_EXAMPLES = 10;

/** P7 : la lecture des évaluations reste dans le module d'administration des pépites (table privée). */
async function readCeilingCoverage(now: Date): Promise<CeilingCoverageView | null> {
  try {
    return buildCeilingCoverage(await readAdminCeilingCoverageSales(), now);
  } catch (error) {
    // La mesure ne doit pas masquer le reste du panneau : elle s'affiche « indisponible ».
    console.warn(
      JSON.stringify({
        scope: "admin-catalogue-quality",
        event: "ceiling_coverage_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/** D12 : doublons entre sources, par public.admin_cross_source_duplicates_summary. */
async function readCrossSourceDuplicates(): Promise<CrossSourceDuplicatesView | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc("admin_cross_source_duplicates_summary", {
      p_limit: THREE_SOURCE_EXAMPLES,
    });
    if (error) throw error;
    return buildCrossSourceDuplicates(data as unknown as CrossSourceDuplicatesPayload | null);
  } catch (error) {
    console.warn(
      JSON.stringify({
        scope: "admin-catalogue-quality",
        event: "cross_source_duplicates_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return null;
  }
}

/**
 * Contrôles qualité du catalogue pour /admin/quality : dernier cliché `catalogue-quality`, alertes
 * `catalogue.quality.*` ouvertes, part des ventes à venir dont le plafond est calculable (P7) et doublons entre
 * sources (D12). Même protection que la supervision du pipeline (/api/admin/pipeline, qui lit les mêmes tables) :
 * jeton vérifié, rôle administrateur et double authentification, puis client de service, en lecture seule. Le
 * détail des alertes ne porte que des nombres et des identifiants de vente.
 */
export async function getAdminCatalogueQuality(
  authToken: string,
  now = new Date(),
): Promise<AdminCatalogueQualityView> {
  await assertAdminAuth(authToken);

  const [snapshotResult, alertsResult, ceilingCoverage, crossSourceDuplicates] = await Promise.all([
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
    readCeilingCoverage(now),
    readCrossSourceDuplicates(),
  ]);
  if (snapshotResult.error) throw snapshotResult.error;
  if (alertsResult.error) throw alertsResult.error;

  return {
    ...buildAdminCatalogueQualityView(
      snapshotResult.data?.[0] ?? null,
      alertsResult.data ?? [],
      now,
    ),
    ceilingCoverage,
    crossSourceDuplicates,
  };
}
