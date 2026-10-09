"use client";

import { createFileRoute } from "@/lib/router-compat";
import { SearchPage } from "@/components/search/SearchPage";
import { validateSalesSearch } from "@/lib/search/search-url-state";

export const Route = createFileRoute("/sales/")({
  validateSearch: validateSalesSearch,
  component: SalesPage,
});

export function SalesPage({ serverSeeded = false }: { serverSeeded?: boolean }) {
  const search = Route.useSearch();
  return <SearchPage search={search} serverSeeded={serverSeeded} />;
}
