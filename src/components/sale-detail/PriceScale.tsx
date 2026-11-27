import { formatEuro } from "@/lib/auction-scenarios";
import { formatPrice } from "@/lib/format";
import type { UsualAuctionRange } from "@/components/sale-detail/use-usual-auction-range";
import styles from "./PriceTrio.module.css";

/** Position (0 à 100) d'un montant sur l'échelle `[min, max]`. */
function position(value: number, min: number, max: number): number {
  if (max <= min) return 50;
  return Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100));
}

/**
 * Bornes de la réglette : de 10 % sous le plus petit montant à 10 % au-dessus du plus grand,
 * arrondies au millier. `null` sans au moins deux montants à comparer.
 */
export function priceScaleBounds(values: readonly number[]): { min: number; max: number } | null {
  const amounts = values.filter((value) => Number.isFinite(value) && value > 0);
  if (amounts.length < 2) return null;
  const low = Math.min(...amounts);
  const high = Math.max(...amounts);
  const pad = Math.max((high - low) * 0.1, high * 0.02);
  return {
    min: Math.max(0, Math.floor((low - pad) / 1000) * 1000),
    max: Math.ceil((high + pad) / 1000) * 1000,
  };
}

/**
 * Réglette à l'échelle : la mise à prix, l'enchère plafond, la valeur estimée, la fourchette de
 * marché (en beige) et les prix habituellement atteints par les ventes comparables (en hachures)
 * placés sur un même axe. Chaque montant manquant est simplement absent ; la réglette n'apparaît
 * qu'avec deux montants au moins.
 */
export function PriceScale({
  startingPrice,
  startLabel,
  ceiling,
  value,
  range,
  usual = null,
}: {
  startingPrice: number | null;
  /** « Mise à prix », « Première offre possible ». */
  startLabel: string;
  ceiling: number | null;
  value: number | null;
  range: { low: number; high: number } | null;
  /** Moitié centrale des prix d'adjudication des ventes comparables ; `null` : pas de chiffre. */
  usual?: UsualAuctionRange | null;
}) {
  const bounds = priceScaleBounds(
    [startingPrice, ceiling, value, range?.low, range?.high, usual?.low, usual?.high].filter(
      (amount): amount is number => amount != null,
    ),
  );
  if (!bounds) return null;
  const { min, max } = bounds;
  const description = [
    startingPrice != null ? `${startLabel} ${formatPrice(startingPrice)}` : null,
    ceiling != null ? `enchère plafond ${formatPrice(ceiling)}` : null,
    value != null ? `valeur estimée ${formatPrice(value)}` : null,
    range ? `fourchette de marché de ${formatPrice(range.low)} à ${formatPrice(range.high)}` : null,
    usual
      ? `prix habituellement atteints de ${formatEuro(usual.low)} à ${formatEuro(usual.high)}`
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <figure className={styles.scale} data-testid="price-scale">
      <div className={styles.track} role="img" aria-label={`Échelle de prix : ${description}.`}>
        <div className={styles.axis}>
          {range ? (
            <span
              className={styles.band}
              style={{
                left: `${position(range.low, min, max)}%`,
                right: `${100 - position(range.high, min, max)}%`,
              }}
            />
          ) : null}
          {usual ? (
            <span
              className={styles.bandUsual}
              data-testid="price-scale-usual"
              style={{
                left: `${position(usual.low, min, max)}%`,
                right: `${100 - position(usual.high, min, max)}%`,
              }}
            />
          ) : null}
          {usual?.median != null ? (
            <span
              className={styles.usualMedian}
              style={{ left: `${position(usual.median, min, max)}%` }}
            />
          ) : null}
        </div>
        {startingPrice != null ? (
          <span className={styles.marker} style={{ left: `${position(startingPrice, min, max)}%` }}>
            <span>{startLabel}</span>
            <i />
          </span>
        ) : null}
        {ceiling != null ? (
          <span
            className={`${styles.marker} ${styles.markerCeiling}`}
            style={{ left: `${position(ceiling, min, max)}%` }}
          >
            <span>Plafond</span>
            <i />
          </span>
        ) : null}
        {value != null ? (
          <span
            className={`${styles.marker} ${styles.markerValue}`}
            style={{ left: `${position(value, min, max)}%` }}
          >
            <span>Valeur</span>
            <i />
          </span>
        ) : null}
      </div>
      <figcaption className={styles.bounds} aria-hidden>
        <span>{formatPrice(min)}</span>
        {range ? <span>Fourchette de marché en beige</span> : null}
        <span>{formatPrice(max)}</span>
      </figcaption>
      {usual ? (
        <p className={styles.usualNote} data-testid="price-scale-usual-note">
          <span>
            Hachures : une vente comparable sur deux{" "}
            {usual.scope === "court" && usual.courtName
              ? `du ${usual.courtName}`
              : usual.scope === "court"
                ? "de ce tribunal"
                : "des tribunaux couverts"}{" "}
            a été adjugée entre <strong>{formatEuro(usual.low)}</strong> et{" "}
            <strong>{formatEuro(usual.high)}</strong>, une sur quatre au-dessus, une sur quatre en
            dessous
            {usual.median != null ? ` (prix médian : environ ${formatEuro(usual.median)})` : ""},
            avant éventuelle surenchère et hors frais. Ce repère ignore l’état du bien et le nombre
            d’enchérisseurs : ce n’est pas une prévision.{" "}
            <a href="#statistiques">Voir les scénarios d’enchères</a>
          </span>
        </p>
      ) : null}
    </figure>
  );
}
