import type { Metadata } from "next";
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { pageMetadata } from "@/lib/page-metadata";
import { loadInitialCatalogue } from "@/lib/public-catalogue.server";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import { RPC_LIMITS } from "@/lib/search/preview-search-request";
import { DEFAULT_SEARCH_LIMIT } from "@/lib/search/search-filters";
import { salesSearchSignature, type SalesSearchParams } from "@/lib/search/search-url-state";
import { SalesPage } from "./sales-page";

const SALES_TITLE = "Ventes immobilières aux enchères en France";
const SALES_DESCRIPTION =
  "Consultez les ventes immobilières aux enchères : tribunal, notaire et État. Filtrez par lieu, type de bien, budget et date de vente.";

/**
 * Métadonnées de `/sales` pour la première page et pour toute adresse filtrée : l'adresse canonique
 * est `/sales`. Les pages suivantes du catalogue non filtré ont les leurs (`salesPageMetadata`).
 */
export const salesMetadata: Metadata = pageMetadata({
  path: "/sales",
  title: SALES_TITLE,
  description: SALES_DESCRIPTION,
});

/** Dernière page que la recherche publique sait servir pour la taille de page par défaut. */
const LAST_REACHABLE_PAGE = Math.floor(RPC_LIMITS.maxOffset / DEFAULT_SEARCH_LIMIT) + 1;

/**
 * Métadonnées de l'adresse `search`, communes à la page rendue à la demande (`./page.tsx`) et aux
 * variantes statiques (`./defaut/page.tsx`, `./defaut/[page]/page.tsx`), qui disent la même chose :
 *  - page 2 et suivantes SANS autre critère : une page à part entière, canonique `/sales?page=N` et
 *    titre « … - page N » (chaque page a ses propres annonces ; une canonique `/sales` pour toutes
 *    les ferait passer pour des doublons de la première) ;
 *  - première page et toute adresse filtrée : canonique `/sales`.
 */
export function salesPageMetadata(search: SalesSearchParams): Metadata {
  const page = search.page ?? 1;
  const unfiltered =
    salesSearchSignature({ ...search, page: undefined }) === salesSearchSignature({});
  if (page < 2 || page > LAST_REACHABLE_PAGE || !unfiltered) return salesMetadata;
  return pageMetadata({
    path: `/sales?page=${page}`,
    // Absolu : avec « - Immojudis » le titre dépasserait les 60 caractères que les moteurs affichent.
    title: { absolute: `${SALES_TITLE} - page ${page}` },
    description: `${SALES_DESCRIPTION} Page ${page}.`,
  });
}

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
 *
 * `staticQuery` : adresse (sans `?`) pour laquelle une variante statique est rendue, par exemple
 * `page=2`. Une page statique ne lit pas l'adresse (`useSearchParams()` y est vide côté serveur) ;
 * `SalesPage` s'en sert pour le HTML et l'hydratation, puis lit l'adresse réelle.
 *
 * `requireServerSeed` : lève l'erreur au lieu de rendre la page sans liste quand la base est
 * indisponible. Pour la variante statique (ISR) : une page vide serait gardée 5 minutes, alors que
 * l'erreur laisse Next.js servir la dernière bonne page et retenter à la requête suivante (voir
 * `mustSeedStaticCatalogue`). Hors régénération, la page rendue à la demande garde son repli : le
 * navigateur charge alors les annonces.
 */
export async function renderSalesCatalogue(
  search: SalesSearchParams,
  {
    dataUpdatedAt,
    requireServerSeed = false,
    staticQuery,
  }: { dataUpdatedAt?: number; requireServerSeed?: boolean; staticQuery?: string } = {},
) {
  const initial = await loadInitialCatalogue(search);
  if (!initial && requireServerSeed) {
    throw new Error(
      "Catalogue public indisponible : la régénération de /sales est abandonnée, la dernière page valide reste servie.",
    );
  }

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
      <SalesPage serverSeeded={initial !== null} staticQuery={staticQuery} />
    </HydrationBoundary>
  );
}
