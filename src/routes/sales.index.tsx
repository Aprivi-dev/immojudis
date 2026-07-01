import { createFileRoute } from "@/lib/router-compat";
import { SearchPage } from "@/components/search/SearchPage";
import { validateSalesSearch } from "@/lib/search/search-url-state";

export const Route = createFileRoute("/sales/")({
  validateSearch: validateSalesSearch,
  head: () => ({
    meta: [
      { title: "Recherche immobilière — Immojudis" },
      {
        name: "description",
        content:
          "Recherchez les ventes immobilières avec filtres, tri, carte interactive et URL partageable.",
      },
    ],
  }),
  component: SalesPage,
});

function SalesPage() {
  const search = Route.useSearch();
  return <SearchPage search={search} />;
}
