import TriangleAlert from "lucide-react/dist/esm/icons/triangle-alert.js";
import { Badge } from "@/components/ui/primitives";
import type { EstimatedFee } from "@/lib/bid-ceiling-engine";

/** Le texte de la pastille : une icône et ces mots, jamais la couleur seule. */
export const ESTIMATED_FEES_TEXT = "Frais estimés, à confirmer";

/**
 * La pastille « Frais estimés, à confirmer » : un poste important du calcul (frais préalables,
 * garantie, honoraires de négociation) vient d'une valeur par défaut et non de l'annonce. Ton
 * `warning` (à vérifier), avec une icône et le texte ; les postes concernés sont écrits à côté.
 * Rien n'est affiché quand tous les postes importants sont lus ou saisis.
 */
export function EstimatedFeesBadge({
  items,
  className,
}: {
  items: readonly EstimatedFee[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-2 gap-y-1 ${className ?? ""}`}>
      <Badge tone="warning">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        {ESTIMATED_FEES_TEXT}
      </Badge>
      <span className="text-caption">
        {items.map((item) => item.label.toLowerCase()).join(", ")}
      </span>
    </span>
  );
}
