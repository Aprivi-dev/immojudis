import { publicEnv } from "@/lib/env";

const CONFIGURATION_ERROR =
  "La configuration Supabase est absente. Ajoutez les variables d'environnement Supabase pour afficher les données.";

/**
 * Même condition que `isSupabaseConfigured` (`@/integrations/supabase/client`), lue ici sans
 * importer ce module : il embarque `supabase-js`, qui ne doit pas entrer dans le premier
 * chargement du catalogue d'un visiteur anonyme.
 */
function isSupabaseConfigured() {
  const { supabaseUrl, supabasePublishableKey } = publicEnv();
  return Boolean(supabaseUrl && supabasePublishableKey);
}

export function assertCloudConfigured() {
  if (isSupabaseConfigured()) return true;
  // On the SSR worker the env may not be hydrated yet — return false so
  // callers can short-circuit with empty results and let the browser
  // refetch once the user session and env are available.
  if (typeof window === "undefined") return false;
  throw new Error(CONFIGURATION_ERROR);
}
