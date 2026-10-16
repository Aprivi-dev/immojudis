import { publicEnv } from "@/lib/env";
import type { WithdrawnSourcesClient } from "@/lib/withdrawn-sources";

/**
 * Lecteur anonyme de `get_withdrawn_catalogue_sources` pour le navigateur, sans `supabase-js`.
 *
 * La fonction est ouverte au rôle `anon` (voir la migration `licitor_source_withdrawal`) : un appel
 * REST avec la clé publique donne la même réponse que `supabase.rpc(...)` pour un visiteur, sans
 * charger tout le client d'authentification sur chaque page. Les erreurs (réseau, fonction absente,
 * Supabase non configuré) sont rendues comme `error`, et `loadWithdrawnSources` retombe alors sur
 * l'état par défaut « aucune source retirée ».
 */
export function createWithdrawnSourcesClient(
  fetcher: typeof fetch = (...args) => fetch(...args),
): WithdrawnSourcesClient {
  return {
    rpc: async (fn) => {
      const { supabaseUrl, supabasePublishableKey } = publicEnv();
      if (!supabaseUrl || !supabasePublishableKey) {
        return { data: null, error: new Error("Supabase non configuré") };
      }
      try {
        const response = await fetcher(`${supabaseUrl.replace(/\/+$/u, "")}/rest/v1/rpc/${fn}`, {
          method: "POST",
          cache: "no-store",
          headers: {
            apikey: supabasePublishableKey,
            Authorization: `Bearer ${supabasePublishableKey}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        if (!response.ok) return { data: null, error: new Error(`HTTP ${response.status}`) };
        return { data: (await response.json()) as unknown, error: null };
      } catch (error) {
        return { data: null, error };
      }
    },
  };
}
