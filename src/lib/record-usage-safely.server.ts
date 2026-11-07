import "server-only";
import { recordFeatureUsageEvent } from "@/lib/usage";

export function recordUsageSafely(input: Parameters<typeof recordFeatureUsageEvent>[0]): void {
  try {
    void recordFeatureUsageEvent(input).catch(() => undefined);
  } catch {
    // La mesure d'usage ne doit jamais retarder ni faire échouer la lecture des statistiques de l'offre Analyse.
  }
}
