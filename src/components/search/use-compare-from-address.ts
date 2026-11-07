import { useEffect, useRef, useState } from "react";
import { COMPARE_SALE_PARAM, type ComparedSale } from "@/lib/search/sale-comparison";
import type { AuctionSale } from "@/lib/types";

/**
 * « Comparer » d'une fiche : `/sales?comparer=<id>`. Le paramètre est lu une fois, à l'arrivée sur le
 * catalogue, puis retiré de l'adresse (un rechargement ou un lien copié ne rajoute rien). La vente est
 * ajoutée à la comparaison dès que le compte est connu (`scope` non nul) : la barre de comparaison (la
 * pastille « Comparer (N) » sur mobile) apparaît avec elle, et un message le confirme. La suite
 * (`addSaleFromAddress` : lecture de la vente, messages) n'est chargée que pour une adresse qui porte
 * ce paramètre.
 */
export function useCompareFromAddress({
  scope,
  signedIn,
  discovery,
  items,
  toggle,
}: {
  /** Portée de la comparaison (`useSaleComparison`) ; `null` tant que le compte n'est pas connu. */
  scope: string | null;
  signedIn: boolean;
  discovery: boolean;
  items: ComparedSale[];
  toggle: (sale: AuctionSale) => void;
}) {
  const [saleToCompare, setSaleToCompare] = useState<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const id = url.searchParams.get(COMPARE_SALE_PARAM);
    if (id == null) return;
    url.searchParams.delete(COMPARE_SALE_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    setSaleToCompare(id);
  }, []);

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!saleToCompare || scope == null) return;
    let cancelled = false;
    void import("@/lib/search/compare-from-address").then(
      ({ addSaleFromAddress }) =>
        addSaleFromAddress(saleToCompare, {
          signedIn,
          discovery,
          items: () => itemsRef.current,
          toggle,
          isCancelled: () => cancelled,
        }).then(() => {
          if (!cancelled) setSaleToCompare(null);
        }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [discovery, saleToCompare, scope, signedIn, toggle]);
}
