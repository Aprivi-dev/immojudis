import type { Metadata } from "next";
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { pageMetadata } from "@/lib/page-metadata";
import { loadInitialCatalogue } from "@/lib/public-catalogue.server";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import type { SalesSearchParams } from "@/lib/search/search-url-state";
import { SalesPage } from "./sales-page";

/**
 * Métadonnées de `/sales`, communes à la page rendue à la demande (`./page.tsx`) et à la variante
 * statique de l'adresse nue (`./defaut/page.tsx`) : l'adresse canonique reste `/sales` pour toute
 * adresse filtrée ou paginée du catalogue, et les deux pages disent exactement la même chose.
 */
export const salesMetadata: Metadata = pageMetadata({
  path: "/sales",
  title: "Ventes immobilières aux enchères en France",
  description:
    "Consultez les ventes immobilières aux enchères : tribunal, notaire et État. Filtrez par lieu, type de bien, budget et date de vente.",
});

/**
 * Le catalogue d'un visiteur déconnecté pour `search`. Le HTML contient déjà les annonces (liens
 * vers chaque vente compris) ; le navigateur garde les mêmes clés React Query, donc l'hydratation
 * réutilise ces lignes sans scintillement.
 *
 * `dataUpdatedAt` : date, en millisecondes, jusqu'à laquelle les lignes comptent comme fraîches
 * dans le navigateur (elles le restent ensuite `staleTime`, 60 s). Par défaut le rendu : la page
 * rendue à la demande vient d'être produite. Une page statique (ISR) est servie jusqu'à 5 minutes
 * après sa génération : sans cette date, ses lignes seraient déjà périmées à l'hydratation et le
 * navigateur relancerait aussitôt la recherche (requête de trop, « Actualisation des annonces… »).
 */
export async function renderSalesCatalogue(
  search: SalesSearchParams,
  { dataUpdatedAt }: { dataUpdatedAt?: number } = {},
) {
  const initial = await loadInitialCatalogue(search);

  const queryClient = new QueryClient();
  if (initial) {
    queryClient.setQueryData(
      salesSearchQueryKey(initial.signature, ANONYMOUS_PREVIEW_SCOPE),
      initial.items,
      { updatedAt: dataUpdatedAt },
    );
    queryClient.setQueryData(
      salesSearchCountQueryKey(initial.signature, ANONYMOUS_PREVIEW_SCOPE),
      initial.count,
      { updatedAt: dataUpdatedAt },
    );
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SalesPage serverSeeded={initial !== null} />
    </HydrationBoundary>
  );
}
