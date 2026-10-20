import { SaleDetailLink } from "@/components/SaleDetailLink";
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
        {/* Jamais « 0 € » : un plafond nul (ancienne saisie) s'affiche comme absent. */}
        {favorite.bidCeilingEur != null && favorite.bidCeilingEur > 0
          ? formatPrice(favorite.bidCeilingEur)
          : "aucun enregistré"}
      </span>
      <SaleDetailLink
        saleId={favorite.saleId}
        returnTo="/favoris"
        className="font-semibold text-gold-text underline"
      >
        Modifier sur la fiche
      </SaleDetailLink>
    </p>
  );
}
