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

/**
 * Le candidat retenu se retrouve par son URL, jamais par sa position : la liste des candidats peut
 * changer entre deux rendus (une copie apparaît ou disparaît) et une position pointerait ailleurs,
 * voire nulle part. On retient donc les URL écartées ; le candidat affiché est le premier qui ne
 * l'est pas.
 */
type VisualSelection = {
  saleId: string;
  rejectedUrls: readonly string[];
  loadedUrl: string | null;
};

const NO_URLS: readonly string[] = [];

const freshSelection = (saleId: string): VisualSelection => ({
  saleId,
  rejectedUrls: NO_URLS,
  loadedUrl: null,
});

/** Une autre vente repart de zéro : l'état d'une vente précédente ne s'applique pas à celle-ci. */
function withRejectedUrl(current: VisualSelection, saleId: string, url: string): VisualSelection {
  const rejected = current.saleId === saleId ? current.rejectedUrls : NO_URLS;
  return {
    saleId,
    rejectedUrls: rejected.includes(url) ? rejected : [...rejected, url],
    loadedUrl: null,
  };
}

function withLoadedUrl(current: VisualSelection, saleId: string, url: string): VisualSelection {
  if (current.saleId === saleId && current.loadedUrl === url) return current;
  return {
    saleId,
    rejectedUrls: current.saleId === saleId ? current.rejectedUrls : NO_URLS,
    loadedUrl: url,
  };
}

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
    const label = credit?.label ? `Photo · ${credit.label}` : "Photo du bien";
    const mirror = photoMirrorForCard(photo.mirror);
    const original: VisualCandidate = { kind: "photo", url: photo.url, label };
    return mirror
      ? [
          { kind: "photo", url: mirror.src, label, mirror: true } satisfies VisualCandidate,
          original,
        ]
      : [original];
  });
  const allCandidates: VisualCandidate[] = [
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
  const [selection, setSelection] = useState<VisualSelection>(freshSelection(sale.id));
  const activeSelection = selection.saleId === sale.id ? selection : freshSelection(sale.id);
  // `every` plutôt que `includes(item.url)` : passer un champ du candidat à un appel fait perdre au
  // compilateur React les dépendances des callbacks ci-dessous (voir `react-hooks/preserve-manual-memoization`).
  const candidate =
    allCandidates.find((item) => activeSelection.rejectedUrls.every((url) => url !== item.url)) ??
    null;
  const candidateUrl = candidate?.url ?? "";
  const candidateKind = candidate?.kind ?? null;
  // Un contrôle de taille de l'image affichée ne vaut que pour une photo de la source.
  const candidateChecksSize = candidateKind === "photo" && !candidate?.mirror;
  const candidateIsReady = Boolean(candidate && activeSelection.loadedUrl === candidate.url);

  const saleId = sale.id;
  const rejectUrl = useCallback(
    (url: string) => setSelection((current) => withRejectedUrl(current, saleId, url)),
    [saleId],
  );
  const markUrlReady = useCallback(
    (url: string) => setSelection((current) => withLoadedUrl(current, saleId, url)),
    [saleId],
  );

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
      rejectUrl(candidateUrl);
      return;
    }

    markUrlReady(candidateUrl);
  }, [candidateChecksSize, candidateUrl, markUrlReady, rejectUrl]);

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

  // Visuels prioritaires (`eager`, souvent l'élément LCP) : une vignette Mapbox ou une copie
  // hébergée est visible dès le HTML serveur, sans attendre onLoad ni l'hydratation (elle restait
  // invisible jusqu'à 5 s de plus). Leur taille est connue et sûre ; en cas d'erreur, le candidat
  // suivant prend la place. La case est déjà dimensionnée par le parent : aucun décalage.
  // Une photo de SOURCE reste masquée jusqu'à onLoad et au contrôle de taille : sinon un logo, une
  // bannière ou une icône d'image cassée serait visible avant l'hydratation. Calculé pour chaque
  // candidat : celui qui prend la suite n'apparaît pas avant d'être chargé, sauf s'il est lui-même
  // révélable sans JavaScript. Les visuels différés gardent le squelette puis le fondu.
  const revealedWithoutScript = eager && (candidate.kind !== "photo" || Boolean(candidate.mirror));
  const revealed = candidateIsReady || revealedWithoutScript;

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
        onError={() => rejectUrl(candidate.url)}
        onLoad={(event) => {
          if (candidateChecksSize && shouldRejectRenderedPropertyImage(event.currentTarget)) {
            rejectUrl(candidate.url);
            return;
          }
          markUrlReady(candidate.url);
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
