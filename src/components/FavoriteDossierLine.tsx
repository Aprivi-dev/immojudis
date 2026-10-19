import Link from "next/link";
import { favoriteDossierStatusLabel } from "@/lib/favorite-dossier-shared";
import { formatPrice } from "@/lib/format";
import type { FavoriteSale } from "@/lib/favorites";

/**
 * « Mon dossier » (point 68) sous la carte d'un favori : le statut et l'enchère plafond que la
 * personne a enregistrés sur la fiche. Une valeur absente s'affiche comme absente.
 */
export function FavoriteDossierLine({
  favorite,
}: {
  favorite: Pick<FavoriteSale, "saleId" | "personalStatus" | "bidCeilingEur">;
}) {
  return (
    <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
      <span>
        <span className="font-semibold text-brand-navy">Mon statut :</span>{" "}
        {favorite.personalStatus ? favoriteDossierStatusLabel(favorite.personalStatus) : "aucun"}
      </span>
      <span>
        <span className="font-semibold text-brand-navy">Mon plafond :</span>{" "}
        {favorite.bidCeilingEur != null ? formatPrice(favorite.bidCeilingEur) : "aucun enregistré"}
      </span>
      <Link href={`/sales/${favorite.saleId}`} className="font-semibold text-gold-text underline">
        Modifier sur la fiche
      </Link>
    </p>
  );
}
