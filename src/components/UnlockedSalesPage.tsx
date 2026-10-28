"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useAuth } from "@/hooks/use-auth";
import { fetchSaleUnlocksOverview } from "@/lib/client-api";
import { formatDate, formatStartingPrice, propertyTypeLabel } from "@/lib/format";
import { saleDetailPath } from "@/lib/navigation";
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
    <main id="contenu" className="mx-auto max-w-3xl px-4 pb-16 pt-28 sm:px-6">
      <Link
        href="/compte"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-gold-text underline underline-offset-4"
      >
        Retour à Mon compte
      </Link>
      <h1 className="mt-2 font-display text-4xl text-foreground">Mes ventes débloquées</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Les ventes dont vous avez ouvert le détail avec vos déblocages par mois. Elles restent
        accessibles tant qu’elles sont en ligne sur Immojudis, dans la limite de 24 mois.
      </p>
      {status && !status.analysisAccess ? (
        <p className="mt-3 text-sm font-medium text-brand-navy">{unlockUsageLine(status)}</p>
      ) : null}

      {overview.isError ? (
        <div role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm">
          <p className="text-red-800">Vos ventes débloquées n’ont pas pu être chargées.</p>
          <button
            type="button"
            className="mt-3 min-h-11 rounded-md border border-red-300 bg-white px-4 font-semibold text-red-800"
            onClick={() => void overview.refetch()}
            disabled={overview.isFetching}
          >
            Réessayer
          </button>
        </div>
      ) : overview.isLoading ? (
        <p role="status" className="mt-6 text-sm text-muted-foreground">
          Chargement de vos ventes débloquées…
        </p>
      ) : sales.length === 0 ? (
        <div className="mt-6 rounded-xl border border-border bg-card p-5 text-sm">
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
        </div>
      ) : (
        <ul className="mt-6 grid gap-3" aria-label="Ventes débloquées">
          {sales.map((sale) => (
            <li key={sale.id} className="rounded-xl border border-border bg-card p-4">
              <Link
                href={saleDetailPath(sale.id)}
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
    </main>
  );
}
