import { getSupabase } from "@/integrations/supabase/lazy";
import {
  fetchLawyerFactSources,
  warnLawyerFactSourcesFailure,
  type LawyerFactSource,
} from "@/lib/lawyer-fact-sources";
import { assertCloudConfigured } from "@/lib/query-configuration";

/**
 * Valeurs de la fiche transmises par l'avocat poursuivant, lues par le navigateur (fiche des comptes,
 * relecture de la fiche publique). Module propre à la fiche : le catalogue ne le charge pas. Une base sans
 * la fonction répond « aucune mention » ; toute autre erreur est tracée (code seul) puis levée, pour que la
 * requête qui l'appelle ne la garde pas comme « aucune mention » et la relise plus tard.
 */
export async function getSaleLawyerFactSources(saleId: string): Promise<LawyerFactSource[]> {
  if (!assertCloudConfigured()) return [];
  try {
    return await fetchLawyerFactSources(await getSupabase(), saleId);
  } catch (error) {
    warnLawyerFactSourcesFailure(error);
    throw error;
  }
}
