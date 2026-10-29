"use client";

import { useQuery } from "@tanstack/react-query";
import { UrbanismeCadastrePanel } from "@/components/sale-detail/UrbanismeCadastrePanel";
import { fetchSaleUrbanismeCadastre } from "@/lib/client-api";
import type { AuctionSale } from "@/lib/types";
import * as queryKeys from "@/lib/query-keys";

/**
 * Urbanisme et cadastre de l'onglet Quartier. Dans son propre module pour être chargé à la demande :
 * le plan cadastral et le potentiel foncier ne pèsent pas sur le premier affichage de la fiche.
 */
export function UrbanismeSection({
  sale,
  mapLocation,
  loadStructuredUrbanism = false,
}: {
  sale: AuctionSale;
  mapLocation: Pick<AuctionSale, "address" | "postal_code" | "city" | "latitude" | "longitude">;
  loadStructuredUrbanism?: boolean;
}) {
  const urbanismQuery = useQuery({
    queryKey: queryKeys.saleUrbanismeCadastre(sale.id, sale.source_url),
    queryFn: () => fetchSaleUrbanismeCadastre(sale.id),
    enabled: loadStructuredUrbanism && Boolean(sale.source_url) && Boolean(sale.city),
    staleTime: 10 * 60_000,
  });

  return (
    <div>
      <div>
        {urbanismQuery.isPending && urbanismQuery.isFetching ? (
          <p role="status" className="mb-4 text-sm text-brand-navy/70">
            Chargement des données cadastrales et d’urbanisme collectées pour cette annonce…
          </p>
        ) : null}
        {urbanismQuery.isError ? (
          <div
            role="alert"
            className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950"
          >
            <p>
              Les données cadastrales complémentaires sont momentanément indisponibles. Le bloc
              ci-dessous repose sur les pièces de l’annonce.
            </p>
            <button
              type="button"
              className="mt-2 font-semibold underline underline-offset-2"
              onClick={() => void urbanismQuery.refetch()}
            >
              Réessayer
            </button>
          </div>
        ) : null}
        <UrbanismeCadastrePanel
          sale={sale}
          mapLocation={mapLocation}
          cadastralParcels={urbanismQuery.data?.cadastralParcels}
          urbanPlanningSignals={urbanismQuery.data?.urbanPlanningSignals}
          officialLandEnabled={loadStructuredUrbanism}
        />
      </div>
    </div>
  );
}
