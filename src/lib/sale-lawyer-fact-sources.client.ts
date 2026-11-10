import { getSupabase } from "@/integrations/supabase/lazy";
import { fetchLawyerFactSources, type LawyerFactSource } from "@/lib/lawyer-fact-sources";
import { assertCloudConfigured } from "@/lib/query-configuration";

/**
 * Valeurs de la fiche transmises par l'avocat poursuivant, lues par le navigateur (fiche des comptes,
 * relecture de la fiche publique). Module propre à la fiche : le catalogue ne le charge pas. Aucune
 * panne ne remonte : sans réponse, la fiche s'affiche sans mention.
 */
export async function getSaleLawyerFactSources(saleId: string): Promise<LawyerFactSource[]> {
  try {
    if (!assertCloudConfigured()) return [];
    return await fetchLawyerFactSources(await getSupabase(), saleId);
  } catch {
    return [];
  }
}
