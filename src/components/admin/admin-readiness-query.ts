import { queryOptions } from "@tanstack/react-query";
import { READINESS_QUERY_KEY } from "@/lib/admin-query-keys";
import { fetchAdminReadiness } from "@/lib/client-api";

/**
 * Diagnostic opérationnel (alertes ouvertes comprises) : une seule définition pour l'accueil,
 * Opérations > Alertes et le diagnostic des services. La même clé fait qu'une page qui
 * affiche la liste des alertes et la pastille de santé n'envoie qu'une requête.
 */
export const adminReadinessQuery = () =>
  queryOptions({
    queryKey: READINESS_QUERY_KEY,
    queryFn: fetchAdminReadiness,
    staleTime: 30_000,
  });
