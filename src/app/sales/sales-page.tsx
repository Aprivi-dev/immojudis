"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useSearchParams } from "next/navigation";
import { SearchPage } from "@/components/search/SearchPage";
import { searchParamsToRecord } from "@/lib/navigation";
import { validateSalesSearch } from "@/lib/search/search-url-state";

const subscribeNothing = () => () => undefined;

/**
 * Vrai dans le navigateur une fois l'hydratation faite, faux pour le HTML du serveur et pendant
 * l'hydratation (le `getServerSnapshot` de React sert aussi à celle-ci : aucune différence de
 * rendu à signaler).
 */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

/**
 * Catalogue filters live in the URL and change without a page load (`history.replaceState`),
 * so they are read in the browser; the server page seeds the first render for the same URL.
 *
 * `staticQuery` : la variante statique d'une page (`/sales/defaut/2`, servie à l'adresse
 * `/sales?page=2`) est rendue sans lire d'adresse : `useSearchParams()` y est vide côté serveur. Elle
 * donne ici l'adresse qu'elle représente, pour le HTML et l'hydratation ; ensuite c'est l'adresse
 * du navigateur qui fait foi (filtres, pages suivantes).
 */
export function SalesPage({
  serverSeeded = false,
  staticQuery,
}: {
  serverSeeded?: boolean;
  staticQuery?: string;
}) {
  const searchParams = useSearchParams();
  const hydrated = useHydrated();
  const queryString =
    staticQuery !== undefined && !hydrated ? staticQuery : searchParams.toString();
  const search = useMemo(
    () => validateSalesSearch(searchParamsToRecord(new URLSearchParams(queryString))),
    [queryString],
  );
  return <SearchPage search={search} serverSeeded={serverSeeded} />;
}
