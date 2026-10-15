import { EMOLUMENT_SCALE_DATE, EMOLUMENT_SCALE_REFERENCE } from "@/lib/profitability";
import { cn } from "@/lib/utils";
import { formatScaleDate } from "./scale-date";

/**
 * Avertissement de fin de résultat. Il reprend celui de la page (estimation indicative, frais
 * préalables à vérifier dans le cahier des conditions de vente) et celui du reste du site (ni conseil
 * juridique ni conseil financier).
 */
export function SimulatorDisclaimer({ className }: { className?: string }) {
  return (
    <p className={cn("text-xs leading-relaxed text-ink-soft", className)}>
      Estimation indicative, au barème du {formatScaleDate(EMOLUMENT_SCALE_DATE)} (
      {EMOLUMENT_SCALE_REFERENCE}) : elle ne constitue ni un conseil juridique ni un conseil
      financier. Les frais préalables réels figurent dans le cahier des conditions de vente ; faites
      vérifier les montants par votre avocat.
    </p>
  );
}
