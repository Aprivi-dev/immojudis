import { getSupabase } from "@/integrations/supabase/lazy";
import {
  fetchDocumentFactSources,
  warnDocumentFactSourcesFailure,
  type DocumentFactSource,
} from "@/lib/document-fact-sources";
import { assertCloudConfigured } from "@/lib/query-configuration";

/**
 * Valeurs de la fiche relevées automatiquement dans les pièces, lues par le navigateur (fiche des comptes,
 * relecture de la fiche publique). Module propre à la fiche : le catalogue ne le charge pas. Une erreur est
 * tracée (code seul) puis levée, pour que la requête qui l'appelle ne la garde pas comme « aucune mention » et la
 * relise plus tard.
 */
export async function getSaleDocumentFactSources(saleId: string): Promise<DocumentFactSource[]> {
  if (!assertCloudConfigured()) return [];
  try {
    return await fetchDocumentFactSources(await getSupabase(), saleId);
  } catch (error) {
    warnDocumentFactSourcesFailure(error);
    throw error;
  }
}
