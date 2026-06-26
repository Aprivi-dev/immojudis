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

export const Route = createFileRoute("/sales/$id")({
  component: SaleDetailPage,
  errorComponent: SaleErrorComponent,
  notFoundComponent: SaleNotFoundComponent,
});

function SaleDetailPage() {
  const { id } = Route.useParams();
  const {
    data: sale,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["sale", id],
    queryFn: () => getSaleById(id),
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
