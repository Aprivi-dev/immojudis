"use client";

import { ListingPhoto } from "@/components/ListingPhoto";
import { useEffect, useRef, useState } from "react";
import type { UIEvent } from "react";
import dynamic from "next/dynamic";
import ArrowLeft from "lucide-react/dist/esm/icons/arrow-left.js";
import ArrowRight from "lucide-react/dist/esm/icons/arrow-right.js";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { StreetViewDialog } from "@/components/StreetViewDialog";
import { PhotoCredit, PhotoCredits } from "@/components/PhotoCredit";
import { SaleVisual } from "@/components/SaleVisual";
import { AerialOrbitHero } from "@/components/sale-detail/AerialOrbitHero";
import listingStyles from "@/components/sale-detail/SaleListing.module.css";
import { propertyTypeLabel } from "@/lib/format";
import { getMapboxAccessToken } from "@/lib/mapbox";
import { aerialOrbitTarget, hasReliableBuildingPosition } from "@/lib/sale-aerial-orbit";
import { listingCoordinates } from "@/lib/sale-listing";
import { photoCredit } from "@/lib/photo-credit";
import { photoMirrorForCard, photoMirrorForDetail } from "@/lib/photo-mirror";
import { propertyImages } from "@/lib/sale-media";
import { saleDisplayTitle } from "@/lib/sale-title";
import {
  getAiReviewFieldResult,
  type AiReviewProjectionReadModel,
  type AiReviewRequestStatus,
} from "@/lib/ai-review-guard";
import type { AuctionSale } from "@/lib/types";

const PhotoCarouselDialog = dynamic(
  () => import("@/components/PhotoCarouselDialog").then((module) => module.PhotoCarouselDialog),
  { ssr: false },
);

export function PropertyIdentity({
  sale,
  aiReviewProjections = null,
  aiReviewStatus = "ready",
  publicDemo = false,
}: {
  sale: AuctionSale;
  aiReviewProjections?: readonly AiReviewProjectionReadModel[] | null;
  aiReviewStatus?: AiReviewRequestStatus;
  /** Page d'exemple : la vue aérienne reste une image fixe, la carte animée n'est jamais chargée. */
  publicDemo?: boolean;
}) {
  const images = propertyImages(sale.media);
  // La source d'une photo est l'hôte de son URL d'ORIGINE (jamais celui de notre copie).
  const creditOf = (index: number) => photoCredit(images[index]?.url, sale);
  const [galleryIndex, setGalleryIndex] = useState<number | null>(null);
  // Vignettes dont la photo ne s'est pas chargée : sans aucune vignette valide, le bloc disparaît.
  const [failedThumbnails, setFailedThumbnails] = useState<ReadonlySet<number>>(() => new Set());
  const markThumbnailFailed = (index: number) =>
    setFailedThumbnails((current) => (current.has(index) ? current : new Set(current).add(index)));
  const thumbnailIndexes = images.slice(0, 4).map((_, index) => index);
  const allThumbnailsFailed =
    thumbnailIndexes.length > 0 && thumbnailIndexes.every((index) => failedThumbnails.has(index));
  const [mobilePhotoIndex, setMobilePhotoIndex] = useState(0);
  const mobileCarouselRef = useRef<HTMLDivElement>(null);
  // Visuel choisi par le visiteur ou imposé par `?visuel=photos|vue` (lu après l'affichage : la page
  // reste statique) ; `clicked` : le choix vient d'un geste, qui vaut demande de chargement de la carte.
  const [chosen, setChosen] = useState<"photos" | "vue" | null>(null);
  const [clicked, setClicked] = useState(false);
  useEffect(() => {
    const forced = new URLSearchParams(window.location.search).get("visuel");
    if (forced === "photos" || forced === "vue") setChosen(forced);
  }, []);
  const propertyTypeReview = getAiReviewFieldResult(
    aiReviewProjections,
    "property.property_type",
    aiReviewStatus,
  );
  const cityReview = getAiReviewFieldResult(aiReviewProjections, "property.city", aiReviewStatus);
  const title =
    propertyTypeReview.blocked || cityReview.blocked
      ? propertyTypeReview.blocked
        ? "Type de bien à confirmer"
        : `${propertyTypeLabel(sale.property_type)} · Localisation à confirmer`
      : saleDisplayTitle(sale, propertyTypeLabel(sale.property_type));
  const address = [sale.address, sale.postal_code, sale.city].filter(Boolean).join(", ");
  const mapLocation = cityReview.blocked ? null : listingCoordinates(sale);
  const eligibleOrbit = mapLocation && getMapboxAccessToken() ? aerialOrbitTarget(sale) : null;
  // Avec deux photos ou plus, les photos viennent d'abord ; avec une seule photo (ou aucune), la vue
  // aérienne passe devant quand la position est sûre, et la photo devient une vignette sous le visuel.
  // Le sélecteur « Photos / Vue 360° » laisse le choix quand les deux existent.
  const selectable = Boolean(eligibleOrbit && images[0]);
  const view = !eligibleOrbit
    ? "photos"
    : !images[0]
      ? "vue"
      : (chosen ?? (images.length > 1 ? "photos" : "vue"));
  const orbitTarget = view === "vue" ? eligibleOrbit : null;
  // Une fois la vue 360° affichée, elle reste montée (masquée quand « Photos » est choisi) : la
  // démonter puis la remonter relancerait un chargement Mapbox facturé à chaque bascule. Tant
  // qu'elle n'a jamais été affichée, elle n'est pas montée et rien n'est chargé.
  const [orbitSeen, setOrbitSeen] = useState(false);
  if (orbitTarget && !orbitSeen) setOrbitSeen(true);

  const locationButtons = (location: { lat: number; lng: number }) => (
    <>
      <StreetViewDialog
        target={{ ...location, address }}
        className="min-h-10 rounded-md border-white/70 bg-white/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
      />
      <MapboxPreviewButton
        mode="streetLevel"
        lat={location.lat}
        lng={location.lng}
        label="Quartier 3D"
        title="Vue 3D du quartier"
        description={address || "Adresse de l'annonce"}
        ariaLabel="Afficher la vue 3D Mapbox du quartier"
        icon={MapPin}
        className="inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
      />
    </>
  );

  const handleMobileCarouselScroll = (event: UIEvent<HTMLDivElement>) => {
    const carousel = event.currentTarget;
    if (!carousel.clientWidth) return;
    const nextIndex = Math.round(carousel.scrollLeft / carousel.clientWidth);
    setMobilePhotoIndex(Math.min(Math.max(nextIndex, 0), images.length - 1));
  };

  const goToMobilePhoto = (nextIndex: number) => {
    const carousel = mobileCarouselRef.current;
    if (!carousel || !images.length) return;
    const clampedIndex = Math.min(Math.max(nextIndex, 0), images.length - 1);
    carousel.scrollTo({ left: clampedIndex * carousel.clientWidth, behavior: "smooth" });
    setMobilePhotoIndex(clampedIndex);
  };

  return (
    <div className={listingStyles.heroGallery}>
      {selectable ? (
        <div
          role="group"
          aria-label="Visuel du bien"
          className="mb-2 inline-flex rounded-lg border border-brand-navy/15 bg-white p-0.5"
        >
          {(["photos", "vue"] as const).map((choice) => (
            <button
              key={choice}
              type="button"
              aria-pressed={view === choice}
              onClick={() => {
                setChosen(choice);
                setClicked(true);
              }}
              className={`min-h-10 rounded-md px-4 text-xs font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft ${
                view === choice ? "bg-brand-navy text-white" : "text-brand-navy hover:bg-surface"
              }`}
            >
              {choice === "photos" ? "Photos" : "Vue 360°"}
            </button>
          ))}
        </div>
      ) : null}
      <div className={listingStyles.photo}>
        {eligibleOrbit && mapLocation && (orbitTarget || orbitSeen) ? (
          // `contents` ne s'applique qu'affichée : la classe l'emporterait sur l'attribut `hidden`.
          <div hidden={!orbitTarget} className={orbitTarget ? "contents" : undefined}>
            <AerialOrbitHero
              target={eligibleOrbit}
              title={title}
              publicDemo={publicDemo}
              startImmediately={clicked}
              className={listingStyles.orbitMain}
            />
            {/* Au-dessus du logo Mapbox, que les conditions d'utilisation imposent visible. */}
            <div className="absolute bottom-9 left-3 z-10 flex max-w-[calc(100%-1.5rem)] flex-wrap gap-2 md:left-4">
              {locationButtons(mapLocation)}
            </div>
          </div>
        ) : null}
        {orbitTarget ? null : images[0] ? (
          <>
            <div
              ref={mobileCarouselRef}
              role="region"
              aria-roledescription="carrousel"
              aria-label={`Photos de ${title}`}
              onScroll={handleMobileCarouselScroll}
              className="flex h-[clamp(15rem,65vw,22rem)] snap-x snap-mandatory scroll-smooth overflow-x-auto overscroll-x-contain bg-muted [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden"
            >
              {images.map((image, index) => (
                <button
                  key={`${image.url}-${index}`}
                  type="button"
                  onClick={() => setGalleryIndex(index)}
                  className="group relative block h-full w-full max-w-full flex-none snap-start snap-always overflow-hidden bg-muted text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold-soft"
                  aria-label={`Ouvrir la photo ${index + 1} sur ${images.length}`}
                >
                  <ListingPhoto
                    src={image.url}
                    mirror={photoMirrorForDetail(image.mirror)}
                    alt={
                      index === 0
                        ? `Photo principale de ${title}`
                        : `Photo ${index + 1} de ${title}`
                    }
                    className="h-full w-full object-cover"
                    loading={index === 0 ? "eager" : "lazy"}
                    fetchPriority={index === 0 ? "high" : "low"}
                    decoding="async"
                    draggable={false}
                    referrerPolicy="strict-origin-when-cross-origin"
                  />
                </button>
              ))}
            </div>
            {images.length > 1 ? (
              <>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex - 1)}
                  disabled={mobilePhotoIndex === 0}
                  className="absolute left-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo précédente"
                >
                  <ArrowLeft className="h-5 w-5" aria-hidden />
                </button>
                <button
                  type="button"
                  onClick={() => goToMobilePhoto(mobilePhotoIndex + 1)}
                  disabled={mobilePhotoIndex === images.length - 1}
                  className="absolute right-3 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-white/70 bg-white/92 text-brand-navy shadow-lg backdrop-blur transition hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft disabled:pointer-events-none disabled:opacity-35 md:hidden"
                  aria-label="Photo suivante"
                >
                  <ArrowRight className="h-5 w-5" aria-hidden />
                </button>
              </>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(0)}
              className={`${listingStyles.galleryMain} group relative hidden w-full overflow-hidden bg-muted text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold-soft md:block`}
              aria-label="Ouvrir la galerie photos"
            >
              <ListingPhoto
                src={images[0].url}
                mirror={photoMirrorForDetail(images[0].mirror)}
                fetchPriority="high"
                alt={`Photo principale de ${title}`}
                className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.015]"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
            {mapLocation ? (
              <div className="absolute bottom-8 left-3 z-10 flex max-w-[calc(100%-6rem)] flex-wrap gap-2 md:bottom-4 md:left-4">
                {locationButtons(mapLocation)}
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => setGalleryIndex(mobilePhotoIndex)}
              className="absolute bottom-8 right-3 z-10 inline-flex min-h-10 items-center gap-2 rounded-md border border-white/70 bg-white/95 px-3 py-2 text-xs font-semibold text-brand-navy shadow-lg backdrop-blur transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft md:bottom-4 md:right-4"
              // The name contains the visible text at every breakpoint (WCAG 2.5.3).
              aria-label={`Ouvrir la galerie de ${images.length} photo${images.length > 1 ? "s" : ""}, photo ${mobilePhotoIndex + 1} / ${images.length}`}
            >
              <Camera className="h-4 w-4" aria-hidden />
              <span className="md:hidden" aria-live="polite">
                {mobilePhotoIndex + 1} / {images.length}
              </span>
              <span className="hidden md:inline">
                {images.length} photo{images.length > 1 ? "s" : ""}
              </span>
            </button>
          </>
        ) : (
          <SaleVisual
            sale={sale}
            title={title}
            className={listingStyles.visualMain}
            reliablePosition={hasReliableBuildingPosition(sale)}
            eager
          />
        )}
      </div>

      {orbitTarget && images[0] && !allThumbnailsFailed ? (
        <div className="mt-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-xs font-semibold text-brand-navy">Photos de l’annonce</p>
            <button
              type="button"
              onClick={() => setGalleryIndex(0)}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md text-xs font-semibold text-brand-navy underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
            >
              <Camera className="h-4 w-4" aria-hidden />
              {images.length > 1 ? `Voir les ${images.length} photos` : "Voir la photo"}
            </button>
          </div>
          <div className="mt-1 grid grid-cols-4 gap-2">
            {images.slice(0, 4).map((image, index) => {
              const hidden = images.length - 4;
              const last = index === 3 && hidden > 0;
              return (
                <button
                  key={`${image.url}-${index}`}
                  type="button"
                  onClick={() => setGalleryIndex(index)}
                  className="relative h-16 overflow-hidden rounded-xl border border-brand-navy/10 bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft md:h-20"
                  aria-label={
                    last
                      ? `Ouvrir la photo ${index + 1}, ${hidden} autre${hidden > 1 ? "s" : ""} dans la galerie`
                      : `Ouvrir la photo ${index + 1}`
                  }
                >
                  <ListingPhoto
                    src={image.url}
                    mirror={photoMirrorForCard(image.mirror)}
                    alt={`Photo ${index + 1} de ${title}`}
                    compactFallback
                    className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
                    loading="lazy"
                    referrerPolicy="strict-origin-when-cross-origin"
                    onOriginalError={() => markThumbnailFailed(index)}
                  />
                  {last ? (
                    <span
                      className="absolute inset-0 grid place-items-center bg-night/55 text-sm font-semibold text-white"
                      aria-hidden
                    >
                      +{hidden}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          {/* Une entrée par source des vignettes encore affichées : la photo 1 ne crédite pas les autres. */}
          <PhotoCredits
            credits={thumbnailIndexes
              .filter((index) => !failedThumbnails.has(index))
              .map((index) => creditOf(index))}
            className="mt-1.5 block text-xs text-muted-foreground"
            linkClassName="hover:text-foreground"
          />
        </div>
      ) : images[0] && !orbitTarget ? (
        // Sur grand écran la photo affichée est la principale ; sur mobile, celle du carrousel.
        <PhotoCredit
          credit={creditOf(mobilePhotoIndex)}
          className="mt-1.5 block text-xs text-muted-foreground"
          linkClassName="hover:text-foreground"
        />
      ) : null}

      {!orbitTarget && images.length > 1 ? (
        <div className="mt-2 hidden grid-cols-3 gap-2 md:grid">
          {images.slice(1, 4).map((image, index) => (
            <button
              key={image.url}
              type="button"
              onClick={() => setGalleryIndex(index + 1)}
              className="h-20 overflow-hidden rounded-xl border border-brand-navy/10 bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
              aria-label={`Ouvrir la photo ${index + 2}`}
            >
              <ListingPhoto
                src={image.url}
                mirror={photoMirrorForCard(image.mirror)}
                alt={`Photo ${index + 2} de ${title}`}
                compactFallback
                className="h-full w-full object-cover transition-transform duration-300 hover:scale-[1.03]"
                loading="lazy"
                referrerPolicy="strict-origin-when-cross-origin"
              />
            </button>
          ))}
        </div>
      ) : null}

      {galleryIndex != null ? (
        <PhotoCarouselDialog
          images={images.map((image, index) => ({
            id: `${image.url}-${index}`,
            url: image.url,
            alt: index === 0 ? `Photo principale de ${title}` : `Photo ${index + 1} de ${title}`,
            source: image.source,
            mirror: image.mirror,
            credit: photoCredit(image.url, sale),
          }))}
          initialIndex={galleryIndex}
          title={title}
          onClose={() => setGalleryIndex(null)}
        />
      ) : null}
    </div>
  );
}
