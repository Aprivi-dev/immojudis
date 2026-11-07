"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Button, Card, Notice, PageShell } from "@/components/ui/primitives";
import { useAuth } from "@/hooks/use-auth";
import { fetchSaleUnlocksOverview } from "@/lib/client-api";
import { formatDate, formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { UNLOCKED_SALES_PATH, saleDetailPath } from "@/lib/navigation";
import * as queryKeys from "@/lib/query-keys";
import { unlockUsageLine, type UnlockedSaleSummary } from "@/lib/sale-unlocks";

function saleLine(sale: UnlockedSaleSummary): string {
  const place = [sale.city, sale.department].filter(Boolean).join(" · ");
  const type = sale.propertyType ? propertyTypeLabel(sale.propertyType) : null;
  return [type, place].filter(Boolean).join(" à ");
}

/**
 * « Mes ventes débloquées » : les ventes que ce compte a débloquées (« 3 déblocages par mois ») et
 * qui sont toujours en ligne, avec le compteur du mois. Un déblocage reste valable tant que la vente
 * est en ligne, dans la limite de 24 mois.
 */
export function UnlockedSalesPage() {
  const { user } = useAuth();
  const overview = useQuery({
    queryKey: queryKeys.saleUnlocksOverview(user?.id ?? null),
    queryFn: fetchSaleUnlocksOverview,
    enabled: Boolean(user),
    staleTime: 60_000,
    retry: false,
  });
  const status = overview.data?.status;
  const sales = overview.data?.sales ?? [];

  return (
    <PageShell
      width="narrow"
      breadcrumb={
        <Link
          href="/compte"
          className="mb-2 inline-flex min-h-11 items-center text-sm font-semibold text-gold-text underline underline-offset-4"
        >
          Retour à Mon compte
        </Link>
      }
      eyebrow="Mon espace"
      title="Mes ventes débloquées"
      description={
        <>
          <p>
            Les ventes dont vous avez ouvert le détail avec vos déblocages par mois. Elles restent
            accessibles tant qu’elles sont en ligne sur Immojudis, dans la limite de 24 mois.
          </p>
          {status && !status.analysisAccess ? (
            <p className="mt-3 text-sm font-medium text-brand-navy">{unlockUsageLine(status)}</p>
          ) : null}
        </>
      }
    >
      {overview.isError ? (
        <Notice role="alert" tone="danger">
          <p>Vos ventes débloquées n’ont pas pu être chargées.</p>
          <Button
            variant="danger"
            className="mt-3"
            onClick={() => void overview.refetch()}
            disabled={overview.isFetching}
          >
            Réessayer
          </Button>
        </Notice>
      ) : overview.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Chargement de vos ventes débloquées…
        </p>
      ) : sales.length === 0 ? (
        <Card className="text-sm">
          <p className="text-muted-foreground">
            Vous n’avez encore débloqué aucune vente en ligne. Ouvrez une fiche, puis choisissez «
            Débloquer cette vente ».
          </p>
          <Link
            href="/sales"
            className="mt-3 inline-flex min-h-11 items-center font-semibold text-gold-text underline underline-offset-4"
          >
            Explorer les ventes
          </Link>
        </Card>
      ) : (
        <ul className="grid gap-3" aria-label="Ventes débloquées">
          {sales.map((sale) => (
            <li key={sale.id} className="rounded-xl border border-border bg-card p-4">
              <Link
                href={saleDetailPath(sale.id, UNLOCKED_SALES_PATH)}
                className="font-semibold text-foreground underline underline-offset-4"
              >
                {sale.title ?? "Vente sans titre"}
              </Link>
              <p className="mt-1 text-sm text-muted-foreground">{saleLine(sale) || "—"}</p>
              <p className="mt-1 text-sm text-muted-foreground">
                {sale.saleDate ? `Vente le ${formatDate(sale.saleDate)} · ` : ""}
                {sale.startingPriceEur != null && sale.startingPriceEur > 0
                  ? `Mise à prix ${formatStartingPrice(sale.startingPriceEur)}`
                  : "Mise à prix à confirmer"}
              </p>
            </li>
          ))}
        </ul>
      )}
    </PageShell>
  );
}
