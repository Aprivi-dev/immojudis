import "server-only";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

/**
 * Bail nommé d'un traitement planifié (table `cron_lease`, fonctions `claim_cron_lease` et `release_cron_lease`,
 * migration 20261108110000). Même mécanisme que le bail du traitement d'inondation
 * (`claimFloodRiskLease`, migration 20261106100500) : un bail stocké, pris par une seule instruction SQL, qui
 * expire seul si le traitement meurt avant de le rendre. Une ligne par traitement, créée par migration.
 */

/** Nom des baux existants (une ligne chacun dans `cron_lease`). */
export type CronLeaseName = "sale-pepites" | "information-agent-autopilot";

export type CronLease = { kind: "held"; token: string } | { kind: "busy" };

/**
 * Prend le bail `name` pour `ttlSeconds` (au-delà de `maxDuration` de la route : il expire seul si la passe
 * meurt). `busy` : une autre passe court. Une erreur de la base lève : jamais de passe sans bail.
 */
export async function claimCronLease(name: CronLeaseName, ttlSeconds: number): Promise<CronLease> {
  const { data, error } = await supabaseAdmin.rpc("claim_cron_lease", {
    p_name: name,
    p_ttl_seconds: ttlSeconds,
  });
  if (error) throw new Error(`Cron lease ${name} refused (code ${error.code ?? "unknown"})`);
  return typeof data === "string" && data ? { kind: "held", token: data } : { kind: "busy" };
}

/** Rend le bail. Sans effet (et sans erreur) si la passe l'a déjà perdu. */
export async function releaseCronLease(name: CronLeaseName, token: string): Promise<void> {
  try {
    await supabaseAdmin.rpc("release_cron_lease", { p_name: name, p_token: token });
  } catch {
    // Le bail expire seul : rendre le bail ne doit jamais faire échouer la passe.
  }
}
