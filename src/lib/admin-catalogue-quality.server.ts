import "server-only";
import { requireSupabaseAuthContext } from "@/integrations/supabase/auth-middleware";
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

const CROSS_SOURCE_ALERT_KEY = "catalogue.duplicates.cross_source";
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

/** « La fonction n'existe pas » (migration pas encore appliquée) : PostgREST `PGRST202`, PostgreSQL `42883`. */
function isMissingFunction(error: { code?: string } | null): boolean {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/**
 * D12 : doublons entre sources, par public.admin_cross_source_duplicates_summary (20261112100100). Tant que la
 * fonction n'est pas déployée : le détail du dernier passage de l'alerte `catalogue.duplicates.cross_source`
 * (écrit seulement quand l'alerte s'est ouverte), sinon rien.
 */
async function readCrossSourceDuplicates(): Promise<CrossSourceDuplicatesView | null> {
  try {
    const { data, error } = await supabaseAdmin.rpc("admin_cross_source_duplicates_summary", {
      p_limit: THREE_SOURCE_EXAMPLES,
    });
    if (!error) {
      return buildCrossSourceDuplicates(data as unknown as CrossSourceDuplicatesPayload | null, {
        kind: "function",
      });
    }
    if (!isMissingFunction(error)) throw error;
    const alert = await supabaseAdmin
      .from("operational_alerts")
      .select("last_seen_at,details")
      .eq("alert_key", CROSS_SOURCE_ALERT_KEY)
      .order("last_seen_at", { ascending: false })
      .limit(1);
    if (alert.error) throw alert.error;
    const row = alert.data?.[0];
    return row
      ? buildCrossSourceDuplicates(row.details as CrossSourceDuplicatesPayload, {
          kind: "alert",
          seenAt: row.last_seen_at,
        })
      : null;
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
  const auth = await requireSupabaseAuthContext(authToken);
  if (!auth.isAdmin) throw new Error("Forbidden: accès administrateur requis.");

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
