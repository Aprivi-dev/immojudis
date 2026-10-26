import Link from "next/link";
import { memo, useMemo, type ComponentType } from "react";
import { AiReviewField } from "@/components/sale-detail/AiReviewField";
import { PepiteInfoBadge } from "@/components/PepiteBadge";
import { PointsToVerifyBadge } from "@/components/PointsToVerifyBadge";
import { SaleCountdown } from "@/components/SaleCountdown";
import { SaleProcedureBadge } from "@/components/SaleProcedureBadge";
import { useFeeRegimes } from "@/components/FeeRegimesProvider";
import { useLaunchOffer } from "@/hooks/use-launch-offer";
import { useViewedSales } from "@/hooks/use-viewed-sales";
import {
  AI_REVIEW_SURFACE_FIELD_KEYS,
  firstBlockedAiReviewField,
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import { pointsToVerify } from "@/lib/search/points-to-verify";
import { stateListingStatus } from "@/lib/property-characteristics";
import { saleIsTribunalVenue } from "@/lib/sale-procedure";
import { getDisplaySurface } from "@/lib/surface";
import type { AuctionSale } from "@/lib/types";
import {
  LISTING_DETAIL_LINE,
  PAST_SALE_LABEL,
  cardTypeLabel,
  departmentLabel,
  listingAccessLine,
  listingDateLabel,
  listingLinkLabel,
  listingPriceText,
  listingTitle,
  stateSaleWithoutPrice,
} from "./listing-text";
import { useSaleDetailLink } from "./use-sale-detail-link";

const SKELETON_ROWS = 8;

type FavoriteButtonComponent = ComponentType<{
  saleId: string;
  locked: boolean;
  favoriteScope: string | null;
  initialFavorite: boolean;
}>;

/**
 * Les mêmes annonces que les cartes, en lignes, pour parcourir beaucoup de dossiers : commune,
 * type, surface, prix, date, statut. Rien n'y est affiché que la carte ne montre pas au même
 * visiteur (mêmes champs, même relecture IA, mêmes règles d'accès). Le tri est celui de la
 * recherche (menu « Tri » au-dessus), pas un tri propre au tableau : les en-têtes ne trient pas.
 */
export function SearchResultsTable({
  sales,
  returnTo,
  locked,
  analysisLocked,
  verifying = false,
  isLoading,
  selectedSaleId,
  hoveredSaleId,
  onHover,
  onSelect,
  unlockedIds,
  pepiteSaleIds,
  pepiteExposedSaleIds,
  favoriteIds,
  favoriteScope,
  FavoriteButton,
  aiReviewBySaleId,
  aiReviewStatus = "disabled",
}: {
  sales: AuctionSale[];
  returnTo: string;
  locked: boolean;
  analysisLocked: boolean;
  /** Compte reconnu, liste publique gardée le temps de la vérification : ligne d'accès neutre. */
  verifying?: boolean;
  isLoading: boolean;
  selectedSaleId: string | null;
  hoveredSaleId: string | null;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
  /** Ventes que le compte Découverte a débloquées. */
  unlockedIds: ReadonlySet<string>;
  /** Pépites publiables : une icône « Pépite » (avec son texte pour lecteur d'écran) dans la colonne Statut. */
  pepiteSaleIds?: ReadonlySet<string>;
  /** Parmi les pépites, celles dont le bien est dans le périmètre d'un PPRi (mention courte). */
  pepiteExposedSaleIds?: ReadonlySet<string>;
  favoriteIds: ReadonlySet<string>;
  favoriteScope: string | null;
  /** Le cœur des cartes (`CompactFavoriteButton`), fourni par la liste qui porte l'état des favoris. */
  FavoriteButton: FavoriteButtonComponent;
  aiReviewBySaleId?: Readonly<Record<string, readonly AiReviewProjectionReadModel[]>>;
  aiReviewStatus?: AiReviewRequestStatus;
}) {
  // Sans résultat, c'est l'état vide de la liste qui parle : pas de tableau creux.
  if (!isLoading && sales.length === 0) return null;

  return (
    <div
      // Le tableau est une vue d'écran large : en dessous de lg, la liste de cartes reste seule.
      className="hidden overflow-x-auto rounded-xl border border-line-soft bg-white shadow-[0_1px_2px_rgba(19,34,56,0.05)] lg:block"
      role="region"
      aria-label="Résultats sous forme de tableau"
      tabIndex={0}
    >
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="sr-only">
          Annonces de cette page : commune et département, type de bien, surface, prix, date de
          vente et statut
        </caption>
        <thead className="border-b border-line-soft bg-surface-muted text-xs text-ink-soft">
          <tr>
            <th scope="col" className="px-3 py-2 font-semibold">
              Commune
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Type de bien
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Surface
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Prix
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Date de vente
            </th>
            <th scope="col" className="px-3 py-2 font-semibold">
              Statut
            </th>
            <th scope="col" className="px-1 py-2 font-semibold">
              <span className="sr-only">Favori</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {isLoading
            ? Array.from({ length: SKELETON_ROWS }).map((_, index) => (
                <tr key={index} aria-hidden="true" className="border-b border-line-soft">
                  <td colSpan={7} className="px-3 py-4">
                    <div className="h-4 w-full animate-pulse rounded bg-surface-tint" />
                  </td>
                </tr>
              ))
            : sales.map((sale) => (
                <ListingRow
                  key={sale.id}
                  sale={sale}
                  returnTo={returnTo}
                  locked={locked}
                  verifying={verifying}
                  analysisLocked={analysisLocked}
                  active={selectedSaleId === sale.id || hoveredSaleId === sale.id}
                  onHover={onHover}
                  onSelect={onSelect}
                  unlocked={unlockedIds.has(sale.id)}
                  pepite={pepiteSaleIds?.has(sale.id.toLowerCase()) === true}
                  pepiteFloodExposed={
                    pepiteSaleIds?.has(sale.id.toLowerCase()) === true &&
                    pepiteExposedSaleIds?.has(sale.id.toLowerCase()) === true
                  }
                  aiReviewProjections={aiReviewBySaleId?.[sale.id]}
                  aiReviewStatus={aiReviewStatus}
                  favoriteScope={favoriteScope}
                  initialFavorite={favoriteIds.has(sale.id)}
                  FavoriteButton={FavoriteButton}
                />
              ))}
        </tbody>
      </table>
    </div>
  );
}

const ListingRow = memo(function ListingRow({
  sale,
  returnTo,
  locked,
  verifying = false,
  analysisLocked,
  active,
  onHover,
  onSelect,
  unlocked,
  pepite = false,
  pepiteFloodExposed = false,
  aiReviewProjections,
  aiReviewStatus,
  favoriteScope,
  initialFavorite,
  FavoriteButton,
}: {
  sale: AuctionSale;
  returnTo: string;
  locked: boolean;
  verifying?: boolean;
  analysisLocked: boolean;
  active: boolean;
  onHover: (saleId: string | null) => void;
  onSelect: (saleId: string | null) => void;
  unlocked: boolean;
  pepite?: boolean;
  pepiteFloodExposed?: boolean;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus: AiReviewRequestStatus;
  favoriteScope: string | null;
  initialFavorite: boolean;
  FavoriteButton: FavoriteButtonComponent;
}) {
  const { isViewed } = useViewedSales();
  const detailLink = useSaleDetailLink(sale.id, returnTo);
  const viewed = !locked && isViewed(sale.id);
  // Mêmes points que la carte (l'occupation n'est comptée que si elle est montrée).
  const premiumLocked = locked || analysisLocked;
  const verifyPoints = useMemo(
    () => pointsToVerify(sale, { occupancyVisible: !premiumLocked }),
    [sale, premiumLocked],
  );
  const displaySurface = getDisplaySurface(sale);
  const tribunal = saleIsTribunalVenue(sale);
  const title = listingTitle(sale, { locked, aiReviewProjections, aiReviewStatus });
  const cityReview = getAiReviewFieldResult(aiReviewProjections, "property.city", aiReviewStatus);
  const surfaceReviewField = firstBlockedAiReviewField(
    aiReviewProjections,
    AI_REVIEW_SURFACE_FIELD_KEYS,
    aiReviewStatus,
  );
  // Cession de l'État en ligne sans échéance publiée : « Procédure à venir » plutôt que « Date à confirmer ».
  const stateListing = stateListingStatus(sale);
  const showCity = cityReview.blocked || Boolean(sale.city?.trim());
  const departmentLine = departmentLabel(sale.department);
  const { active: launchOffer, pending: launchPending } = useLaunchOffer();
  const openFeeRegimes = useFeeRegimes()?.open;
  const accessLine = listingAccessLine(sale, {
    locked,
    analysisLocked,
    unlocked,
    verifying,
    launchOffer,
    launchPending,
    openFeeRegimes,
  });
  const surfaceText = displaySurface.value != null ? displaySurface.label : "Surface n.c.";
  const review = {
    projections: aiReviewProjections,
    reviewStatus: aiReviewStatus,
    sourceName: sale.source_name,
    sourceUrl: sale.source_url,
    showSourceLink: false,
  } as const;

  return (
    <tr
      onMouseEnter={() => onHover(sale.id)}
      onMouseLeave={() => onHover(null)}
      onFocusCapture={() => onHover(sale.id)}
      onBlurCapture={() => onHover(null)}
      className={`border-b border-line-soft align-top last:border-b-0 ${active ? "bg-surface-tint" : "hover:bg-surface-muted"}`}
    >
      <th scope="row" className="min-w-0 px-3 py-3 text-left font-normal">
        <Link
          id={`sale-card-${sale.id}`}
          href={detailLink.href}
          {...detailLink.armProps}
          prefetch={false}
          onClick={() => onSelect(sale.id)}
          aria-label={listingLinkLabel(sale, title, {
            price: getAiReviewFieldResult(
              aiReviewProjections,
              "sale.starting_price_eur",
              aiReviewStatus,
            ).blocked,
            date: getAiReviewFieldResult(aiReviewProjections, "sale.sale_date", aiReviewStatus)
              .blocked,
            pepite,
            floodExposed: pepiteFloodExposed,
          })}
          className="font-semibold text-brand-navy underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
        >
          {showCity ? (
            <AiReviewField fieldKey="property.city" fallback="Localisation à préciser" {...review}>
              {sale.city}
            </AiReviewField>
          ) : (
            "Localisation à préciser"
          )}
        </Link>
        {departmentLine ? (
          <span className="mt-0.5 block text-xs text-ink-soft">{departmentLine}</span>
        ) : null}
        {accessLine !== LISTING_DETAIL_LINE ? (
          <span className="mt-0.5 block text-xs text-ink-soft">{accessLine}</span>
        ) : null}
      </th>
      <td className="px-3 py-3">
        <AiReviewField
          fieldKey="property.property_type"
          fallback="Type de bien à confirmer"
          {...review}
        >
          {cardTypeLabel(sale.property_type)}
        </AiReviewField>
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        {surfaceReviewField ? (
          <AiReviewField fieldKey={surfaceReviewField} fallback="Surface à confirmer" {...review}>
            {surfaceText}
          </AiReviewField>
        ) : (
          surfaceText
        )}
      </td>
      <td className="px-3 py-3">
        <span className="block whitespace-nowrap font-bold text-gold-text">
          <AiReviewField fieldKey="sale.starting_price_eur" {...review}>
            {listingPriceText(sale)}
          </AiReviewField>
        </span>
        {stateSaleWithoutPrice(sale) ? null : (
          <span className="block text-xs text-ink-soft">
            {tribunal ? "Mise à prix" : "Prix publié"}
          </span>
        )}
      </td>
      <td className="px-3 py-3">
        {tribunal ? <span className="block text-xs text-ink-soft">Audience</span> : null}
        <AiReviewField fieldKey="sale.sale_date" {...review}>
          {stateListing ? stateListing.label : listingDateLabel(sale)}
        </AiReviewField>
      </td>
      <td className="px-3 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {pepite ? <PepiteInfoBadge variant="icon" floodExposed={pepiteFloodExposed} /> : null}
          {unlocked ? (
            <span className="rounded-md bg-gold px-2 py-0.5 text-[11px] font-bold text-brand-navy">
              Débloquée
            </span>
          ) : null}
          {viewed ? (
            <span className="rounded-md bg-surface-tint px-2 py-0.5 text-[11px] font-bold text-brand-navy">
              Vu
            </span>
          ) : null}
          <SaleCountdown
            sale={sale}
            precisionUnknown={locked}
            variant="chip"
            omitPast={!stateListing && listingDateLabel(sale) === PAST_SALE_LABEL}
          />
          <SaleProcedureBadge sale={sale} />
          {/* Pas la place d'un libellé en tableau : une icône, au nom accessible « N points à vérifier ». */}
          <PointsToVerifyBadge
            variant="icon"
            points={verifyPoints}
            detailHref={detailLink.href}
            detailLinkProps={detailLink.armProps}
            onNavigate={() => onSelect(sale.id)}
          />
        </div>
      </td>
      <td className="px-1 py-1 text-right">
        <FavoriteButton
          key={`${sale.id}:${favoriteScope ?? "anonymous"}`}
          saleId={sale.id}
          locked={locked}
          favoriteScope={favoriteScope}
          initialFavorite={initialFavorite}
        />
      </td>
    </tr>
  );
});
