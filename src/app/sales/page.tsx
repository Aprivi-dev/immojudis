import { validateSalesSearch } from "@/lib/search/search-url-state";
import { renderSalesCatalogue, salesMetadata } from "./sales-catalogue";

// The canonical stays `/sales` for every filtered or paginated address of the catalogue.
export const metadata = salesMetadata;

// This page is rendered at request time: it reads `searchParams`, so every filtered or paginated
// address (`/sales?page=2`) gets its own server-rendered HTML for visitors and crawlers. The bare
// address `/sales` never reaches it: `src/proxy.ts` rewrites it to the static variant
// `./defaut/page.tsx` (ISR, 5 minutes), see `src/lib/sales-isr.ts`.

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
  // The signed-out catalogue is rendered here so that the first HTML already contains the listings
  // (links to every sale included).
  return renderSalesCatalogue(validateSalesSearch(flattenSearchParams(await searchParams)));
}
