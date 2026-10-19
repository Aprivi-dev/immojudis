"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useRef, useState } from "react";
import { MAX_COMPARED_SALES, type ComparedSale } from "@/lib/search/sale-comparison";

const SaleComparisonDialog = dynamic(() => import("./SaleComparisonDialog"), {
  loading: () => (
    <p role="status" className="px-4 py-2 text-sm">
      Chargement du comparateur…
    </p>
  ),
});

export function SaleComparisonBar({
  items,
  returnTo,
  userId,
  onRemove,
  onClear,
  onRestore,
  open: controlledOpen,
  onOpenChange,
  hideWhenEmpty = false,
}: {
  hideWhenEmpty?: boolean;
  /**
   * Fenêtre du comparateur pilotée de l'extérieur : sous `lg` la barre est masquée et la fenêtre
   * s'ouvre par la pastille « Comparer (N) » de la barre basse (voir `MobileMapToggle`). Sans ces
   * deux propriétés, la barre garde son propre état.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  items: ComparedSale[];
  returnTo: string;
  userId: string | null;
  onRemove: (saleId: string) => void;
  onClear: () => void;
  onRestore: (items: ComparedSale[]) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const open = controlledOpen ?? ownOpen;
  const setOpen = (value: boolean) => (onOpenChange ?? setOwnOpen)(value);
  const [hasOpened, setHasOpened] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const barRef = useRef<HTMLElement>(null);

  if (hideWhenEmpty && items.length === 0 && !open) return null;

  return (
    <>
      <section
        ref={barRef}
        tabIndex={-1}
        aria-label="Sélection à comparer"
        // Sous `lg` : masquée, la pastille « Comparer (N) » de la barre basse la remplace. Elle ne
        // reste collée sous l'en-tête que sur grand écran.
        className="z-20 hidden border-y border-line-soft bg-surface-tint px-3 py-3 shadow-sm outline-none sm:px-5 lg:sticky lg:top-[var(--sales-header-height)] lg:block"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-extrabold text-brand-navy">Comparateur gratuit</h2>
            <p role="status" className="mt-0.5 text-xs text-ink-soft">
              {items.length === 0
                ? `Choisissez jusqu’à ${MAX_COMPARED_SALES} biens dans la liste.`
                : `${items.length}/${MAX_COMPARED_SALES} biens sélectionnés${items.length === MAX_COMPARED_SALES ? " · Retirez un bien pour en ajouter un autre." : "."}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {userId ? (
              <Link href="/favoris" className="px-2 py-3 text-sm font-bold underline">
                Mes favoris
              </Link>
            ) : null}
            {items.length > 0 ? (
              <button
                type="button"
                onClick={onClear}
                className="min-h-11 rounded-md px-2 text-xs font-bold text-ink-soft hover:bg-white focus-visible:outline-2 focus-visible:outline-gold"
              >
                Effacer la sélection
              </button>
            ) : null}
            <button
              ref={triggerRef}
              type="button"
              disabled={items.length === 0 && !userId}
              onClick={() => {
                setHasOpened(true);
                setOpen(true);
              }}
              className="min-h-11 rounded-md bg-brand-navy px-3 text-sm font-bold text-white hover:bg-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-50"
            >
              {items.length === 0 && userId ? "Mes comparaisons" : `Comparer (${items.length})`}
            </button>
          </div>
        </div>
      </section>
      {hasOpened || open ? (
        <SaleComparisonDialog
          open={open}
          items={items}
          returnTo={returnTo}
          userId={userId}
          onOpenChange={setOpen}
          onRemove={(saleId) => {
            onRemove(saleId);
            if (items.length === 1) setOpen(false);
          }}
          onRestore={onRestore}
          onRestoreFocus={() => {
            // Barre masquée (mobile) : le focus revient à la pastille de la barre basse.
            if (barRef.current && getComputedStyle(barRef.current).display === "none") {
              document.querySelector<HTMLElement>("[data-comparison-pill]")?.focus();
            } else if (triggerRef.current && !triggerRef.current.disabled) {
              triggerRef.current.focus();
            } else barRef.current?.focus();
          }}
        />
      ) : null}
    </>
  );
}
