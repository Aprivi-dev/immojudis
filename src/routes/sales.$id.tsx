import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  SaleDetailSkeleton,
  SaleDetailView,
  SaleErrorComponent,
  SaleNotFoundComponent,
} from "@/components/SaleDetailView";
import { markSaleViewed } from "@/hooks/use-viewed-sales";
import { getSaleById } from "@/lib/queries";
import { saleSeoTitle } from "@/lib/seo";

export const Route = createFileRoute("/sales/$id")({
  loader: ({ params }) => getSaleById(params.id),
  head: ({ loaderData }) => {
    const title = saleSeoTitle(loaderData);
    return {
      meta: [{ title }, { property: "og:title", content: title }],
    };
  },
  component: SaleDetailPage,
  errorComponent: SaleErrorComponent,
  notFoundComponent: SaleNotFoundComponent,
});

function SaleDetailPage() {
  const { id } = Route.useParams();
  const initialSale = Route.useLoaderData();
  const {
    data: sale,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["sale", id],
    queryFn: () => getSaleById(id),
    initialData: initialSale ?? undefined,
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (sale?.id) markSaleViewed(sale.id);
  }, [sale?.id]);

  if (isLoading) return <SaleDetailSkeleton />;
  if (error) throw error;
  if (!sale) return <SaleNotFoundComponent />;

  return <SaleDetailView sale={sale} />;
}
