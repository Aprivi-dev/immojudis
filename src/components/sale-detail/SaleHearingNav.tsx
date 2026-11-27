import Link from "next/link";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import { formatStartingPrice, formatWeekdayDate, propertyTypeLabel } from "@/lib/format";
import { saleDetailPath } from "@/lib/navigation";
import type { SaleHearing, SaleHearingEntry } from "@/lib/sale-hearing";
import { tribunalCodePagePath } from "@/lib/tribunal-code-path";

function entryLabel(entry: SaleHearingEntry): string {
  return `${propertyTypeLabel(entry.propertyType)} · ${entry.city || "Commune à confirmer"}`;
}

function StepLink({
  entry,
  direction,
}: {
  entry: SaleHearingEntry | undefined;
  direction: "previous" | "next";
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  const label = direction === "previous" ? "Vente précédente" : "Vente suivante";
  const className =
    "inline-flex h-11 w-11 items-center justify-center rounded-full border border-line";
  if (!entry) {
    return (
      <span className={`${className} text-ink-soft opacity-40`} aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
    );
  }
  return (
    <Link
      href={saleDetailPath(entry.id)}
      className={`${className} text-brand-navy hover:border-brand-navy`}
      aria-label={`${label} de l’audience : ${entryLabel(entry)}`}
    >
      <Icon className="h-5 w-5" aria-hidden />
    </Link>
  );
}

/**
 * Bandeau « Audience du … · N ventes » : la position de la vente dans son audience, la vente
 * précédente et la suivante, et la liste des ventes du même tribunal ce jour-là. Rendu par le
 * serveur avec la page de la fiche (aucun état, aucun JavaScript propre dans le navigateur) et posé
 * dans les vues par `SaleHearingSlot`.
 */
export function SaleHearingNav({ hearing }: { hearing: SaleHearing }) {
  const { sales, index } = hearing;
  const day = formatWeekdayDate(hearing.dayKey);
  return (
    <nav
      aria-label="Ventes de la même audience"
      data-testid="sale-hearing-nav"
      className="rounded-lg border border-line bg-white p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 text-sm leading-relaxed">
          <span className="font-semibold text-foreground">Audience du {day}</span>
          <span className="block text-ink-soft">
            {hearing.tribunalCode ? (
              <Link
                href={tribunalCodePagePath(hearing.tribunalCode)}
                className="underline underline-offset-4"
              >
                {hearing.tribunalLabel}
              </Link>
            ) : (
              hearing.tribunalLabel
            )}{" "}
            · {sales.length} ventes
          </span>
        </p>
        <div className="flex items-center gap-2">
          <StepLink entry={sales[index - 1]} direction="previous" />
          <span className="text-sm font-semibold tabular-nums text-foreground">
            {index + 1} / {sales.length}
          </span>
          <StepLink entry={sales[index + 1]} direction="next" />
        </div>
      </div>
      {/* Repliée : la liste ne repousse pas le titre de la fiche ; ses liens restent dans la page. */}
      <details className="mt-2">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-gold-text">
          Les {sales.length} ventes de cette audience
        </summary>
        <ol className="mt-1 divide-y divide-line-soft">
          {sales.map((entry, position) => {
            const row = (
              <>
                <span className="min-w-0">
                  <span className="font-semibold">{entryLabel(entry)}</span>
                  <span className="block text-ink-soft">
                    {entry.time ? `à ${entry.time}` : "heure à confirmer"}
                  </span>
                </span>
                <span className="tabular-nums">
                  <span className="text-ink-soft">Mise à prix </span>
                  <span className="font-semibold">
                    {formatStartingPrice(entry.startingPriceEur)}
                  </span>
                </span>
              </>
            );
            const rowClass =
              "grid min-h-11 gap-1 py-2 text-sm sm:grid-cols-[1fr_auto] sm:items-baseline sm:gap-4";
            return (
              <li key={entry.id}>
                {position === index ? (
                  <span className={rowClass} aria-current="page">
                    {row}
                    <span className="text-xs font-semibold text-gold-text sm:col-span-2">
                      Vous êtes ici
                    </span>
                  </span>
                ) : (
                  <Link
                    href={saleDetailPath(entry.id)}
                    className={`${rowClass} underline-offset-4 hover:underline`}
                  >
                    {row}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </details>
    </nav>
  );
}
