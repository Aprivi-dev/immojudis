import type * as React from "react";
import { useEffect, useState } from "react";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import Map from "lucide-react/dist/esm/icons/map.js";
import X from "lucide-react/dist/esm/icons/x.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import { SearchRejectedError } from "@/lib/search/search-errors";
import { userMessage } from "@/lib/user-messages";
import type { ActiveFilterChip } from "./active-filter-chips";

/**
 * Vrai dès que la page a défilé. Faux au premier rendu (serveur compris) : rien ne s'affiche puis ne
 * disparaît. Une page rouverte plus bas (retour depuis une fiche) le passe à vrai dès le montage.
 */
function useScrolledPastTop(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 0);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return scrolled;
}

/**
 * Bouton flottant du mobile (maquette /sales validée) : « Voir sur la carte », centré au bas de
 * l'écran, et la pastille « Comparer (N) » à côté dès qu'un bien est choisi. Les filtres sont dans
 * la rangée de filtres, sous le champ du lieu (pastille « Filtres »). Seul ce qui flotte porte une
 * ombre. Rien n'intercepte le toucher entre les boutons : la rangée laisse passer les gestes.
 *
 * « Voir sur la carte » n'apparaît qu'après un premier défilement : en haut de page, à 390 × 844, il
 * recouvrait le prix de la première carte. La pastille « Comparer (N) », elle, reste visible dès
 * qu'un bien est choisi (arrivée depuis le « Comparer » d'une fiche comprise).
 */
export function MobileMapToggle({
  comparedCount = 0,
  onOpenComparison,
  onPreloadMap,
  onOpenMap,
}: {
  /** Biens choisis pour la comparaison : au moins un, et la pastille « Comparer (N) » apparaît. */
  comparedCount?: number;
  onOpenComparison?: () => void;
  /** Appelé à l'appui du doigt sur « Voir sur la carte » (avant le clic) pour télécharger la carte à l'avance. */
  onPreloadMap?: () => void;
  onOpenMap: () => void;
}) {
  const scrolled = useScrolledPastTop();
  return (
    // Remontée par `transform`, non par `bottom` : la hauteur du bandeau de cookies est posée après
    // l'hydratation, et changer `bottom` d'une barre fixe décale la page (CLS 0,09 mesuré sur mobile) ;
    // une transformation ne déclenche aucune mise en page.
    <div
      style={{ transform: "translateY(calc(var(--cookie-banner-height, 0px) * -1))" }}
      className="pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center gap-2 px-4 pb-4 lg:hidden"
    >
      <button
        type="button"
        onClick={onOpenMap}
        onPointerDown={onPreloadMap}
        onTouchStart={onPreloadMap}
        className={`pointer-events-auto ${scrolled ? "inline-flex" : "hidden"} h-12 cursor-pointer items-center justify-center gap-2 rounded-full bg-brand-navy px-5 text-[0.9375rem] font-bold text-white shadow-lg transition-colors hover:bg-brand-navy-soft focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft`}
      >
        <Map className="h-[18px] w-[18px]" aria-hidden />
        Voir sur la carte
      </button>
      {comparedCount > 0 && onOpenComparison ? (
        <button
          type="button"
          onClick={onOpenComparison}
          data-comparison-pill=""
          className="pointer-events-auto inline-flex h-12 cursor-pointer items-center justify-center rounded-full border border-brand-navy bg-white px-4 text-sm font-bold text-brand-navy shadow-lg transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
        >
          Comparer ({comparedCount})
        </button>
      ) : null}
    </div>
  );
}
export function NoResultsState({
  filters = [],
  onRemoveFilter,
  onReset,
  onShowFrance,
  alertAction,
  pepite,
}: {
  /**
   * « Me prévenir des prochaines ventes ici » : le bouton d'alerte de la recherche (`SaveSearchButton`),
   * proposé avec les autres actions quand des critères sont actifs. Sans objet quand « Pépites
   * seulement » est actif : l'état vide des pépites a sa propre alerte.
   */
  alertAction?: React.ReactNode;
  /** Critères actifs : chacun peut être retiré seul. */
  filters?: ActiveFilterChip[];
  onRemoveFilter?: (filter: ActiveFilterChip) => void;
  onReset?: () => void;
  /** Proposé seulement si la recherche est limitée à un lieu. */
  onShowFrance?: () => void;
  /**
   * « Pépites seulement » est actif : l'état vide parle des pépites. `count` : pépites publiables en France ;
   * « Élargir à la France » n'est proposé que s'il y en a (et que la recherche est limitée à un lieu).
   */
  pepite?: {
    count: number;
    onKeepOnlyPepite?: () => void;
    onAlert?: () => void;
    alertSaving?: boolean;
  };
}) {
  const others = filters.filter((filter) => filter.key !== "pepite");
  return (
    <div className="rounded-md border border-line-soft bg-white p-6 text-center shadow-sm sm:p-10">
      <SearchIcon className="mx-auto h-8 w-8 text-brand-navy" />
      <h2 className="mt-4 text-xl font-extrabold text-brand-navy">Aucune vente trouvée</h2>
      <p className="mt-2 text-sm font-medium text-ink-soft">
        {pepite
          ? "Aucune pépite avec ces critères pour le moment."
          : "Aucune annonce référencée ne correspond à ces critères pour le moment. Essayez un autre type de vente, une autre zone ou élargissez votre budget."}
      </p>
      {filters.length > 0 && onRemoveFilter ? (
        <ul aria-label="Critères actifs" className="mt-4 flex flex-wrap justify-center gap-2">
          {filters.map((filter) => (
            <li key={filter.key}>
              <button
                type="button"
                onClick={() => onRemoveFilter(filter)}
                aria-label={`Retirer le critère : ${filter.label}`}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-surface-muted px-3 text-sm font-semibold text-brand-navy hover:border-brand-navy"
              >
                {filter.label}
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {onReset || onShowFrance || pepite || alertAction ? (
        <div className="mt-5 flex flex-wrap justify-center gap-3">
          {pepite && others.length > 0 && pepite.onKeepOnlyPepite ? (
            <button
              type="button"
              onClick={pepite.onKeepOnlyPepite}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-md bg-brand-navy px-4 text-sm font-semibold text-white hover:bg-brand-navy-soft"
            >
              Retirer les autres filtres
            </button>
          ) : null}
          {pepite && pepite.count > 0 && onShowFrance ? (
            <button
              type="button"
              onClick={onShowFrance}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-white px-4 text-sm font-semibold text-brand-navy hover:border-brand-navy"
            >
              Élargir à la France
            </button>
          ) : null}
          {pepite?.onAlert ? (
            <button
              type="button"
              onClick={pepite.onAlert}
              disabled={pepite.alertSaving}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-white px-4 text-sm font-semibold text-brand-navy hover:border-brand-navy disabled:opacity-60"
            >
              Me prévenir dès qu’une pépite apparaît
            </button>
          ) : null}
          {!pepite && onReset && filters.length > 0 ? (
            <button
              type="button"
              onClick={onReset}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-md bg-brand-navy px-4 text-sm font-semibold text-white hover:bg-brand-navy-soft"
            >
              Effacer les filtres
            </button>
          ) : null}
          {!pepite && onShowFrance ? (
            <button
              type="button"
              onClick={onShowFrance}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-md border border-line bg-white px-4 text-sm font-semibold text-brand-navy hover:border-brand-navy"
            >
              Voir toute la France
            </button>
          ) : null}
          {!pepite && filters.length > 0 ? alertAction : null}
        </div>
      ) : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  // Recherche refusée par la route (400) : la demande est en cause, pas le catalogue. La rejouer
  // donnerait la même réponse, donc pas de « Réessayer ».
  const rejected = error instanceof SearchRejectedError;
  return (
    <div
      role="alert"
      className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-700"
    >
      <div>
        <p className="font-bold">
          {rejected
            ? "Cette recherche n’est pas possible."
            : "Le catalogue ne répond pas pour le moment."}
        </p>
        <p className="mt-1 font-medium">
          {userMessage(error, "Réessayez dans quelques secondes.")}
        </p>
      </div>
      {onRetry && !rejected ? (
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex min-h-11 items-center rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-bold text-red-700 hover:bg-red-100"
        >
          Réessayer
        </button>
      ) : null}
    </div>
  );
}

export function MapPanelSkeleton() {
  return (
    <div className="grid h-full min-h-[28rem] place-items-center bg-surface-tint">
      <div
        role="status"
        className="inline-flex items-center gap-2 rounded-md border border-line bg-white px-4 py-3 text-sm font-bold text-brand-navy shadow-lg"
      >
        <LoaderCircle className="h-4 w-4 animate-spin text-brand-navy" />
        Chargement de la carte
      </div>
    </div>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-brand-navy/10 px-4 py-8 text-xs font-semibold text-ink-soft sm:px-5">
      Les informations doivent être vérifiées dans les pièces officielles avant toute décision
      d’enchère.
    </footer>
  );
}
