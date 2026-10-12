"use client";

import { useQuery } from "@tanstack/react-query";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { queryKeys } from "@/lib/query-keys";
import {
  buildStreetViewEmbedUrl,
  getGoogleMapsEmbedApiKey,
  googleMapsPlaceUrl,
  hasStreetViewCoordinates,
  streetViewTargetLabel,
  type StreetViewEmbedOptions,
  type StreetViewPanorama,
  type StreetViewTarget,
} from "@/lib/street-view";
import { cn } from "@/lib/utils";
import styles from "./StreetViewDialog.module.css";

export type StreetViewDialogProps = {
  target: StreetViewTarget;
  label?: string;
  title?: string;
  description?: string;
  camera?: StreetViewEmbedOptions;
  className?: string;
  buttonProps?: Omit<ComponentPropsWithoutRef<"button">, "children" | "className" | "type">;
};

async function fetchPanorama(lat: number, lng: number, signal: AbortSignal) {
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng) });
  const response = await fetch(`/api/street-view?${params.toString()}`, { signal });
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
  return ((await response.json()) as { panorama: StreetViewPanorama }).panorama;
}

export function StreetViewDialog({
  target,
  label = "Street View",
  title = "Street View",
  description,
  camera,
  className,
  buttonProps,
}: StreetViewDialogProps) {
  const [open, setOpen] = useState(false);
  const apiKey = getGoogleMapsEmbedApiKey();
  const fallbackUrl = useMemo(
    () => buildStreetViewEmbedUrl(target, apiKey, camera),
    [apiKey, camera, target],
  );
  // The Embed API alone opens the nearest panorama of any kind, often a
  // contributed photo sphere: look up Google's own street imagery first.
  const lookupEnabled =
    open && Boolean(fallbackUrl) && !target.pano?.trim() && hasStreetViewCoordinates(target);
  const panorama = useQuery({
    queryKey: queryKeys.streetViewPanorama(target.lat ?? 0, target.lng ?? 0),
    queryFn: ({ signal }) => fetchPanorama(target.lat as number, target.lng as number, signal),
    enabled: lookupEnabled,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
    refetchOnWindowFocus: false,
  });

  // Configuration is intentionally fail-closed: a missing public key should
  // not leave a dead action in an otherwise usable listing.
  if (!fallbackUrl) return null;

  const targetLabel = streetViewTargetLabel(target);
  const accessibleDescription =
    description ?? `Explorez l’environnement extérieur de ${targetLabel} dans Street View.`;

  let viewport: ReactNode;
  if (!open) {
    viewport = null;
  } else if (lookupEnabled && panorama.isPending) {
    viewport = (
      <div className={styles.loading} role="status">
        <p>Recherche de la vue de la rue la plus proche…</p>
      </div>
    );
  } else if (panorama.data?.status === "unavailable") {
    viewport = (
      <div className={styles.unavailable} role="status">
        <p>
          Google ne propose pas de vue de la rue à moins de 120 m de cette adresse.
          {hasStreetViewCoordinates(target) ? (
            <>
              {" "}
              <a
                className="underline underline-offset-2"
                href={googleMapsPlaceUrl(target.lat as number, target.lng as number)}
                target="_blank"
                rel="noopener noreferrer"
              >
                Voir l’emplacement dans Google Maps
              </a>
            </>
          ) : null}
        </p>
      </div>
    );
  } else {
    const ready = panorama.data?.status === "ready" ? panorama.data : null;
    // A failed lookup keeps the previous behaviour (nearest panorama).
    const src = ready
      ? buildStreetViewEmbedUrl({ ...target, pano: ready.pano }, apiKey, {
          heading: ready.heading ?? undefined,
          pitch: 0,
          ...camera,
        })
      : fallbackUrl;
    viewport = (
      <iframe
        className={styles.iframe}
        src={src}
        title={`${title} — ${targetLabel}`}
        loading="lazy"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          {...buttonProps}
          type="button"
          className={cn(
            "inline-flex min-h-10 items-center justify-center gap-2 rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 shadow-sm transition-colors hover:border-slate-400 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-700",
            className,
          )}
        >
          <MapPin className="h-4 w-4" aria-hidden="true" />
          <span>{label}</span>
        </button>
      </DialogTrigger>
      <DialogContent className={styles.content}>
        <DialogHeader className={styles.header}>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={styles.description}>
            {accessibleDescription}
          </DialogDescription>
        </DialogHeader>
        <div className={styles.viewport}>{viewport}</div>
      </DialogContent>
    </Dialog>
  );
}
