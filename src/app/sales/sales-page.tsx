"use client";

import { useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { SearchPage } from "@/components/search/SearchPage";
import { searchParamsToRecord } from "@/lib/navigation";
import { validateSalesSearch } from "@/lib/search/search-url-state";

/**
 * Catalogue filters live in the URL and change without a page load (`history.replaceState`),
 * so they are read in the browser; the server page seeds the first render for the same URL.
 */
export function SalesPage({ serverSeeded = false }: { serverSeeded?: boolean }) {
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const search = useMemo(
    () => validateSalesSearch(searchParamsToRecord(new URLSearchParams(queryString))),
    [queryString],
  );
  return <SearchPage search={search} serverSeeded={serverSeeded} />;
}
