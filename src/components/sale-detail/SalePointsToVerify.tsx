import { SaleSignalFeedback } from "@/components/SaleSignalFeedback";
import {
  POINTS_TO_VERIFY_ANCHOR,
  POINTS_TO_VERIFY_NOTE,
  pointsToVerifyLabel,
  type PointToVerify,
} from "@/lib/search/points-to-verify";

/**
 * Les points que la pastille « N points à vérifier » de la liste annonce, repris sur la fiche : la
 * cible de l'ancre `#points-a-verifier`. Les mêmes points, calculés par `pointsToVerify` à partir
 * des mêmes champs. Rien n'est rendu sans point. Avec `saleId`, les comptes connectés peuvent dire en un
 * clic si la liste leur est utile (`SaleSignalFeedback`, point 67) ; sans session, rien de plus.
 */
export function SalePointsToVerify({
  points,
  saleId,
  className = "",
}: {
  points: readonly PointToVerify[];
  saleId?: string;
  className?: string;
}) {
  if (points.length === 0) return null;
  const titleId = `${POINTS_TO_VERIFY_ANCHOR}-title`;
  return (
    <section
      id={POINTS_TO_VERIFY_ANCHOR}
      aria-labelledby={titleId}
      className={`scroll-mt-2 rounded-xl border border-line-soft bg-surface-muted p-4 ${className}`}
    >
      <h2 id={titleId} className="text-base font-semibold text-brand-navy">
        {pointsToVerifyLabel(points.length)}
      </h2>
      <ul className="mt-2 list-disc pl-5 text-sm leading-relaxed text-foreground">
        {points.map((point) => (
          <li key={point.key}>{point.label}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs leading-relaxed text-ink-soft">{POINTS_TO_VERIFY_NOTE}</p>
      {saleId ? <SaleSignalFeedback saleId={saleId} signal="points_to_verify" /> : null}
    </section>
  );
}
