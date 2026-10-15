"use client";

import Link from "next/link";
import { useMemo } from "react";
import { Card, buttonClasses } from "@/components/ui/primitives";
import { minimumSurenchere } from "@/lib/surenchere";
import type { SurenchereReminder } from "@/lib/surenchere-reminder";
import { AmountField, euro, toAmount } from "./fields";
import { SimulatorDisclaimer } from "./SimulatorDisclaimer";

export const DEFAULT_SURENCHERE_PRICE = 100_000;

/**
 * Petit calcul de la surenchère du dixième : à partir d'un prix d'adjudication, le prix minimal
 * d'une surenchère (prix + 10 %). Le rappel du délai est celui de l'article de la rubrique
 * ressources, passé tel quel par la page (`getSurenchereReminder`).
 */
export function SurenchereMode({
  price,
  onPriceChange,
  reminder,
}: {
  price: string;
  onPriceChange: (value: string) => void;
  reminder: SurenchereReminder | null;
}) {
  const amounts = useMemo(() => minimumSurenchere(toAmount(price)), [price]);

  return (
    <div className="grid min-w-0 gap-6 md:grid-cols-2">
      <Card as="section" aria-labelledby="simulateur-surenchere-saisie" className="min-w-0">
        <h2 id="simulateur-surenchere-saisie" className="font-display text-2xl font-semibold">
          Le prix d’adjudication
        </h2>
        <form
          className="mt-4 grid gap-4"
          onSubmit={(event) => event.preventDefault()}
          aria-label="Prix d’adjudication pour la surenchère"
        >
          <AmountField
            label="Prix d’adjudication"
            hint="Le prix principal de la vente, tel qu’il figure au jugement d’adjudication."
            value={price}
            onChange={onPriceChange}
          />
        </form>
      </Card>

      <Card
        as="section"
        aria-labelledby="simulateur-surenchere-resultat"
        className="min-w-0 bg-surface-muted"
      >
        <h2 id="simulateur-surenchere-resultat" className="font-display text-2xl font-semibold">
          Surenchère du dixième
        </h2>
        <div className="mt-4 rounded-lg border border-gold/40 bg-white p-4">
          <p className="text-sm font-semibold">Prix minimal d’une surenchère</p>
          <p
            aria-live="polite"
            aria-atomic="true"
            className="mt-1 break-words font-display text-3xl font-semibold tabular-nums"
          >
            {amounts ? euro.format(amounts.minimumBid) : "Saisissez un prix"}
          </p>
          {amounts ? (
            <p className="mt-1 text-sm text-ink-soft">
              Le prix principal de {euro.format(amounts.principalPrice)} augmenté de 10 %, soit un
              dixième de {euro.format(amounts.tenth)}, arrondi au centime supérieur.
            </p>
          ) : (
            <p className="mt-1 text-sm text-ink-soft">
              Saisissez un prix d’adjudication pour calculer le montant minimal d’une surenchère.
            </p>
          )}
        </div>

        {reminder ? (
          <div className="mt-4 rounded-lg border border-line bg-white p-4 text-sm">
            <p className="font-semibold">Le délai et la règle</p>
            <p className="mt-1 text-ink-soft">{reminder.delay}</p>
            {reminder.scope ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-semibold text-gold-text">
                  Dans quels types de vente ?
                </summary>
                <p className="mt-2 text-xs leading-relaxed text-ink-soft">{reminder.scope}</p>
              </details>
            ) : null}
            <p className="mt-2 text-xs">
              <Link href={reminder.articleHref} className="font-semibold text-gold-text underline">
                {reminder.articleTitle}
              </Link>
            </p>
          </div>
        ) : null}

        <SimulatorDisclaimer className="mt-4" />
        <div className="mt-4">
          <Link href="/sales" className={buttonClasses({ variant: "secondary", size: "md" })}>
            Chiffrer une vente précise
          </Link>
        </div>
      </Card>
    </div>
  );
}
