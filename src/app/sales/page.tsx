import type { Metadata } from "next";
import { validateSalesSearch } from "@/lib/search/search-url-state";
import { renderSalesCatalogue, salesPageMetadata } from "./sales-catalogue";

// This page is rendered at request time: it reads `searchParams`, so every filtered or paginated
// address (`/sales?city=Pau`, `/sales?page=4`) gets its own server-rendered HTML for visitors and
// crawlers. The bare address `/sales` and the pages `?page=2` and `?page=3` (with no other
// parameter) never reach it: `src/proxy.ts` rewrites them to the static variants
// `./defaut/page.tsx` and `./defaut/[page]/page.tsx` (ISR, 5 minutes), see `src/lib/sales-isr.ts`.

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

// The canonical is `/sales` for the first page and for every filtered address; page 2 and beyond of
// the unfiltered catalogue are pages of their own (`/sales?page=N`, title "… - page N").
export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  return salesPageMetadata(validateSalesSearch(flattenSearchParams(await searchParams)));
}

export default async function Page({ searchParams }: PageProps) {
  // The signed-out catalogue is rendered here so that the first HTML already contains the listings
  // (links to every sale included).
  return renderSalesCatalogue(validateSalesSearch(flattenSearchParams(await searchParams)));
}
