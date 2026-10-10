import type { Metadata } from "next";
import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { loadInitialCatalogue } from "@/lib/public-catalogue.server";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { SalesPage } from "@/routes/sales.index";

export const metadata: Metadata = {
  title: "Ventes immobilières aux enchères : tribunal, notaire, État",
  description:
    "Consultez les ventes immobilières aux enchères : tribunal, notaire et État. Filtrez par lieu, type de bien, budget et date de vente.",
  alternates: { canonical: "/sales" },
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Mirrors `useSearchParams` on the client: the last value of a repeated key wins. */
function flattenSearchParams(params: Record<string, string | string[] | undefined>) {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const last = Array.isArray(value) ? value[value.length - 1] : value;
    if (last !== undefined) flat[key] = last;
  }
  return flat;
}

export default async function Page({ searchParams }: PageProps) {
  const search = validateSalesSearch(flattenSearchParams(await searchParams));
  // The signed-out catalogue is rendered here so that the first HTML already
  // contains the listings (links to every sale included). The browser keeps the
  // same React Query keys, so hydration reuses these rows without a flash.
  const initial = await loadInitialCatalogue(search);

  const queryClient = new QueryClient();
  if (initial) {
    queryClient.setQueryData(
      salesSearchQueryKey(initial.signature, ANONYMOUS_PREVIEW_SCOPE),
      initial.items,
    );
    queryClient.setQueryData(
      salesSearchCountQueryKey(initial.signature, ANONYMOUS_PREVIEW_SCOPE),
      initial.count,
    );
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SalesPage serverSeeded={initial !== null} />
    </HydrationBoundary>
  );
}
