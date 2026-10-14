import FileText from "lucide-react/dist/esm/icons/file-text.js";
import { isWellInformedSale } from "@/lib/listing-completeness-ranking";
import type { AuctionSale } from "@/lib/types";

/** Portée du repère, lue par les lecteurs d'écran (un `title` serait invisible au clavier et au tactile). */
export const WELL_INFORMED_BADGE_NOTE =
  "Fiche détaillée : cette annonce a un score de complétude d’au moins 40 sur 100, c’est-à-dire qu’elle réunit une part importante des informations que nous recherchons. Ce repère mesure la quantité d’informations, pas leur exactitude : il ne vaut ni vérification ni garantie sur le bien. Reportez-vous aux pièces officielles de la vente.";

/**
 * Pastille des cartes de résultats : l'annonce est dans le palier haut du classement par
 * complétude (voir `listing-completeness-ranking.ts`). Le libellé est visible et porté par la
 * pastille elle-même ; l'icône est décorative ; la portée du repère est un texte masqué
 * visuellement, sans JavaScript. Rien n'est affiché pour les autres annonces.
 */
export function WellInformedBadge({ sale }: { sale: Pick<AuctionSale, "completeness_tier"> }) {
  if (!isWellInformedSale(sale)) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-gold/40 bg-gold/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-gold-text">
      <FileText className="h-3 w-3" aria-hidden />
      Annonce bien renseignée
      <span className="sr-only">. {WELL_INFORMED_BADGE_NOTE}</span>
    </span>
  );
}
