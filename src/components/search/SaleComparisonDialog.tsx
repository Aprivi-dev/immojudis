"use client";

import { useId, useState } from "react";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SaleComparisonTable } from "./SaleComparisonTable";
import { SavedSaleComparisons } from "./SavedSaleComparisons";
import type { ComparedSale } from "@/lib/search/sale-comparison";

export default function SaleComparisonDialog({
  open,
  items,
  returnTo,
  userId,
  onOpenChange,
  onRemove,
  onRestore,
  onRestoreFocus,
}: {
  open: boolean;
  items: ComparedSale[];
  returnTo: string;
  userId: string | null;
  onOpenChange: (open: boolean) => void;
  onRemove: (saleId: string) => void;
  onRestore: (items: ComparedSale[]) => void;
  onRestoreFocus: () => void;
}) {
  // Sur mobile le pied (comparaisons enregistrées, mentions) prendrait la place du tableau :
  // il est replié par défaut et se déplie à la demande. Dès `sm`, il reste affiché.
  const [footerToggled, setFooterToggled] = useState(false);
  // Sans bien à comparer, les comparaisons enregistrées sont la seule chose à voir : dépliées.
  const footerOpen = footerToggled || items.length === 0;
  const footerId = useId();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="grid max-h-[90svh] w-[calc(100%-1.5rem)] max-w-5xl grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-xl p-0 text-brand-navy"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          onRestoreFocus();
        }}
      >
        <DialogHeader className="border-b border-line-soft px-4 py-4 pr-12 text-left sm:px-6">
          <DialogTitle className="text-xl font-extrabold">Comparer les biens</DialogTitle>
          <DialogDescription>
            Les informations du catalogue, côte à côte. Gratuit, sans compte.
          </DialogDescription>
          <p className="text-xs text-ink-soft">
            {items.length < 2
              ? "Ajoutez un autre bien depuis la liste pour le comparer."
              : "Sur mobile, faites défiler le tableau horizontalement pour voir tous les biens."}
          </p>
        </DialogHeader>
        {items.length ? (
          <SaleComparisonTable items={items} returnTo={returnTo} onRemove={onRemove} />
        ) : (
          <div className="grid min-h-24 place-items-center px-4 text-center text-sm text-ink-soft">
            Restaurez une comparaison ci-dessous ou ajoutez des biens depuis le catalogue.
          </div>
        )}
        <div className="border-t border-line-soft bg-white text-xs leading-relaxed text-ink-soft">
          <button
            type="button"
            aria-expanded={footerOpen}
            aria-controls={footerId}
            onClick={() => setFooterToggled((value) => !value)}
            className="flex min-h-11 w-full items-center justify-between gap-2 px-4 text-left text-sm font-bold text-brand-navy sm:hidden"
          >
            Comparaisons enregistrées et mentions
            <ChevronDown
              aria-hidden="true"
              className={`h-4 w-4 transition-transform ${footerOpen ? "rotate-180" : ""}`}
            />
          </button>
          <div
            id={footerId}
            className={`max-h-[25svh] space-y-3 overflow-y-auto px-4 py-3 sm:block sm:max-h-[42svh] sm:px-6 ${
              footerOpen ? "block" : "hidden"
            }`}
          >
            <SavedSaleComparisons
              items={items}
              returnTo={returnTo}
              userId={userId}
              onRestore={onRestore}
            />
            <p>
              La mise à prix n’est ni le prix final ni le coût total. Les surfaces de nature
              différente ne sont pas directement comparables. Vérifiez les pièces officielles.
            </p>
            <p>
              Sans sauvegarde, la sélection s’efface en quittant ou en rechargeant le catalogue, ou
              en changeant de compte. Les données sont relevées à la sélection et ne s’actualisent
              pas automatiquement.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
