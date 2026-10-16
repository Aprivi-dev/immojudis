import { useCallback, useEffect, useRef, useState } from "react";
import ImageOff from "lucide-react/dist/esm/icons/image-off.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import type { AuctionSale } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  MAPBOX_LIST_THUMBNAIL_FORMAT,
  mapboxSatelliteImageUrl,
  mapboxStaticImageUrl,
} from "@/lib/mapbox";
import { photoCredit } from "@/lib/photo-credit";
import { photoMirrorForCard } from "@/lib/photo-mirror";
import { propertyImages, shouldRejectRenderedPropertyImage } from "@/lib/sale-media";

type SaleVisualProps = {
  sale: AuctionSale;
  title: string;
  locked?: boolean;
  className?: string;
  eager?: boolean;
  mapWidth?: number;
  mapHeight?: number;
  preferPhoto?: boolean;
  /**
   * Vignette de liste : les visuels Mapbox sont demandés à la densité de l'écran (srcset 1x/2x au
   * lieu d'un @2x systématique) et au format WebP.
   */
  thumbnail?: boolean;
  /**
   * Largeur de cadrage de référence (en pixels) du visuel Mapbox. Si elle diffère de `mapWidth`,
   * le zoom est ajusté pour que la zone affichée reste la même (même cadrage, moins de pixels).
   */
  mapFramingWidth?: number;
};

type VisualCandidate = {
  kind: "map" | "photo" | "satellite";
  url: string;
  srcSet?: string;
  label: string;
  /**
   * Notre copie d'une photo. Elle précède la photo de la source dans la liste des candidats : si
   * elle échoue, le candidat suivant est la source elle-même. L'original a déjà été jugé (taille)
   * quand la copie a été retenue, donc le contrôle de taille de l'image affichée ne s'y applique pas.
   */
  mirror?: boolean;
};

type VisualSelection = {
  saleId: string;
  index: number;
  exhausted: boolean;
  loadedUrl: string | null;
};

export function SaleVisual({
  sale,
  title,
  locked = false,
  className = "",
  eager = false,
  mapWidth = 896,
  mapHeight = 672,
  preferPhoto = false,
  thumbnail = false,
  mapFramingWidth,
}: SaleVisualProps) {
  const photos = locked ? [] : propertyImages(sale.media);
  const hasCoordinates = sale.latitude != null && sale.longitude != null;
  const hasPreciseAddress = Boolean(sale.address?.trim());
  // Image plus étroite que la référence : on recule d'autant de niveaux de zoom pour garder la
  // même zone visible (Mapbox arrondit le zoom au centième).
  const zoomOffset =
    mapFramingWidth && mapFramingWidth !== mapWidth ? Math.log2(mapWidth / mapFramingWidth) : 0;
  const framedZoom = (zoom: number) => Math.round((zoom + zoomOffset) * 100) / 100;
  const satelliteImage = mapboxImage(
    !locked && hasCoordinates && hasPreciseAddress,
    thumbnail,
    (pixelRatio) =>
      mapboxSatelliteImageUrl({
        lat: sale.latitude as number,
        lng: sale.longitude as number,
        zoom: framedZoom(17),
        width: mapWidth,
        height: mapHeight,
        pixelRatio,
        format: thumbnail ? MAPBOX_LIST_THUMBNAIL_FORMAT : undefined,
      }),
  );
  const sectorMapImage = mapboxImage(
    !locked && hasCoordinates && !hasPreciseAddress,
    thumbnail,
    (pixelRatio) =>
      mapboxStaticImageUrl({
        lat: sale.latitude as number,
        lng: sale.longitude as number,
        zoom: framedZoom(12),
        width: mapWidth,
        height: mapHeight,
        pixelRatio,
        format: thumbnail ? MAPBOX_LIST_THUMBNAIL_FORMAT : undefined,
      }),
  );
  const photoCandidates: VisualCandidate[] = photos.flatMap((photo) => {
    // La source est celle de la photo (hôte de l'URL d'origine), pas celle de la vente.
    const credit = photoCredit(photo.url, null, { knownOnly: true });
    const label = credit ? `Photo · ${credit.label}` : "Photo du bien";
    const mirror = photoMirrorForCard(photo.mirror);
    const original: VisualCandidate = { kind: "photo", url: photo.url, label };
    return mirror
      ? [
          { kind: "photo", url: mirror.src, label, mirror: true } satisfies VisualCandidate,
          original,
        ]
      : [original];
  });
  const candidates: VisualCandidate[] = [
    ...(preferPhoto ? photoCandidates : []),
    ...(satelliteImage
      ? [{ kind: "satellite" as const, ...satelliteImage, label: "Vue aérienne Mapbox" }]
      : []),
    ...(sectorMapImage
      ? [{ kind: "map" as const, ...sectorMapImage, label: "Carte du secteur Mapbox" }]
      : []),
    ...(preferPhoto ? [] : photoCandidates),
  ];
  const imageRef = useRef<HTMLImageElement>(null);
  const [selection, setSelection] = useState<VisualSelection>({
    saleId: sale.id,
    index: 0,
    exhausted: false,
    loadedUrl: null,
  });
  const activeSelection =
    selection.saleId === sale.id
      ? selection
      : { saleId: sale.id, index: 0, exhausted: false, loadedUrl: null };
  const candidate = activeSelection.exhausted ? null : (candidates[activeSelection.index] ?? null);
  const candidateCount = candidates.length;
  const candidateUrl = candidate?.url ?? "";
  const candidateKind = candidate?.kind ?? null;
  // Un contrôle de taille de l'image affichée ne vaut que pour une photo de la source.
  const candidateChecksSize = candidateKind === "photo" && !candidate?.mirror;
  const candidateIsReady = Boolean(candidate && activeSelection.loadedUrl === candidate.url);

  const rejectCandidate = useCallback(() => {
    setSelection((current) => {
      const index = current.saleId === sale.id ? current.index : 0;
      const nextIndex = index + 1;
      return {
        saleId: sale.id,
        index: nextIndex,
        exhausted: nextIndex >= candidateCount,
        loadedUrl: null,
      };
    });
  }, [candidateCount, sale.id]);

  const markCandidateReady = useCallback(() => {
    if (!candidateUrl) return;

    setSelection((current) => {
      const index = current.saleId === sale.id ? current.index : 0;
      if (current.saleId === sale.id && current.loadedUrl === candidateUrl) return current;

      return {
        saleId: sale.id,
        index,
        exhausted: false,
        loadedUrl: candidateUrl,
      };
    });
  }, [candidateUrl, sale.id]);

  useEffect(() => {
    const image = imageRef.current;
    if (!candidateUrl || !image?.complete) return;

    // An external image can fail before React hydration attaches onError.
    // Re-check the browser's settled image state so the fallback still advances.
    if (
      !image.naturalWidth ||
      !image.naturalHeight ||
      (candidateChecksSize && shouldRejectRenderedPropertyImage(image))
    ) {
      rejectCandidate();
      return;
    }

    markCandidateReady();
  }, [candidateChecksSize, candidateUrl, markCandidateReady, rejectCandidate]);

  if (!candidate) {
    return (
      <div
        className={cn(
          "relative flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br from-background to-surface",
          className,
        )}
      >
        <div className="absolute inset-0 opacity-35 [background-image:radial-gradient(circle_at_22%_18%,rgba(15,118,110,0.22),transparent_28%),linear-gradient(135deg,transparent_45%,rgba(201,141,69,0.16)_46%,transparent_47%)]" />
        <div className="relative px-4 text-center text-brand-navy/75">
          {locked ? (
            <LockKeyhole className="mx-auto h-7 w-7" aria-hidden />
          ) : (
            <ImageOff className="mx-auto h-7 w-7" aria-hidden />
          )}
          <span className="mt-2 block text-xs font-semibold">
            {locked ? "Visuel réservé" : "Aucun visuel fiable"}
          </span>
        </div>
      </div>
    );
  }

  // Visuels prioritaires (`eager`, souvent l'élément LCP) : l'image est visible dès le HTML serveur,
  // sans attendre onLoad ni l'hydratation (elle restait invisible jusqu'à 5 s de plus). On ne la
  // retire qu'en cas d'erreur ou de photo rejetée, ce qui passe au candidat suivant. La case est
  // déjà dimensionnée par le parent : aucun décalage de mise en page. Les visuels différés gardent
  // le squelette puis le fondu à l'arrivée.
  const revealed = candidateIsReady || eager;

  return (
    <div
      className={cn("relative h-full w-full overflow-hidden bg-muted", className)}
      aria-busy={!revealed}
    >
      {!revealed ? (
        <div
          className="absolute inset-0 animate-pulse bg-[linear-gradient(110deg,#e8f1f6_25%,#f7fafc_45%,#e8f1f6_65%)] bg-[length:220%_100%]"
          aria-hidden
        />
      ) : null}
      <img
        ref={imageRef}
        key={candidate.url}
        src={candidate.url}
        srcSet={candidate.srcSet}
        alt={
          candidate.kind === "photo"
            ? title
            : candidate.kind === "satellite"
              ? `Vue aérienne de ${title}`
              : `Carte du secteur de ${title}`
        }
        loading={eager ? "eager" : "lazy"}
        fetchPriority={eager ? "high" : "auto"}
        decoding="async"
        referrerPolicy="strict-origin-when-cross-origin"
        onError={rejectCandidate}
        onLoad={(event) => {
          if (candidateChecksSize && shouldRejectRenderedPropertyImage(event.currentTarget)) {
            rejectCandidate();
            return;
          }
          markCandidateReady();
        }}
        className={`h-full w-full object-cover text-transparent transition duration-500 group-hover:scale-[1.025] ${
          revealed ? "opacity-100" : "opacity-0"
        }`}
      />
      {candidateIsReady ? (
        <span className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md border border-white/65 bg-night/78 px-2 py-1 text-[9px] font-bold uppercase tracking-[0.08em] text-white shadow-sm backdrop-blur">
          {candidate.label}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Visuel Mapbox d'une vignette : une seule URL (@2x) par défaut ; en mode vignette, URL à densité
 * normale et srcset 1x/2x pour que seuls les écrans haute densité téléchargent le @2x.
 */
function mapboxImage(
  enabled: boolean,
  thumbnail: boolean,
  build: (pixelRatio: 1 | 2) => string,
): { url: string; srcSet?: string } | null {
  if (!enabled) return null;
  if (!thumbnail) {
    const url = build(2);
    return url ? { url } : null;
  }

  const oneX = build(1);
  const twoX = build(2);
  if (!oneX) return null;
  return { url: oneX, srcSet: twoX ? `${oneX} 1x, ${twoX} 2x` : undefined };
}
