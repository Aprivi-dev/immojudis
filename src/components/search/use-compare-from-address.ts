import { useEffect, useRef, useState } from "react";
import { toast } from "@/lib/toast";
import {
  COMPARE_SALE_PARAM,
  MAX_COMPARED_SALES,
  compareSaleIdFromParam,
  type ComparedSale,
} from "@/lib/search/sale-comparison";
import type { AuctionSale } from "@/lib/types";

/**
 * « Comparer » d'une fiche : `/sales?comparer=<id>`. Le paramètre est lu une fois, à l'arrivée sur le
 * catalogue, puis retiré de l'adresse (un rechargement ou un lien copié ne rajoute rien). La vente est
 * ajoutée à la comparaison dès que le compte est connu (`scope` non nul) : la barre de comparaison (la
 * pastille « Comparer (N) » sur mobile) apparaît avec elle, et un message le confirme. La lecture de la
 * vente (`fetchComparedSale`) n'est chargée que pour une adresse qui porte ce paramètre.
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
    if (!url.searchParams.has(COMPARE_SALE_PARAM)) return;
    const id = compareSaleIdFromParam(url.searchParams.get(COMPARE_SALE_PARAM));
    url.searchParams.delete(COMPARE_SALE_PARAM);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    if (id) setSaleToCompare(id);
  }, []);

  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(() => {
    if (!saleToCompare || scope == null) return;
    let cancelled = false;
    const failed = () => {
      if (!cancelled) toast.message("Cette vente n’a pas pu être ajoutée à la comparaison.");
    };
    import("@/lib/search/compared-sale")
      .then(({ fetchComparedSale }) => fetchComparedSale(saleToCompare, { signedIn, discovery }))
      .then((sale) => {
        if (cancelled) return;
        setSaleToCompare(null);
        if (!sale) return failed();
        if (itemsRef.current.some((item) => item.id === sale.id)) return;
        if (itemsRef.current.length >= MAX_COMPARED_SALES) return failed();
        toggle(sale);
        toast.message(
          `Vente ajoutée à la comparaison. Choisissez jusqu’à ${MAX_COMPARED_SALES - 1} autres biens dans la liste.`,
        );
      }, failed);
    return () => {
      cancelled = true;
    };
  }, [discovery, saleToCompare, scope, signedIn, toggle]);
}
