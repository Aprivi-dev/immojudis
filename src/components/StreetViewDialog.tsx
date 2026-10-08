"use client";

import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import type { ComponentPropsWithoutRef } from "react";
import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  buildStreetViewEmbedUrl,
  getGoogleMapsEmbedApiKey,
  streetViewTargetLabel,
  type StreetViewEmbedOptions,
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
  const embedUrl = useMemo(
    () => buildStreetViewEmbedUrl(target, apiKey, camera),
    [apiKey, camera, target],
  );

  // Configuration is intentionally fail-closed: a missing public key should
  // not leave a dead action in an otherwise usable listing.
  if (!embedUrl) return null;

  const targetLabel = streetViewTargetLabel(target);
  const accessibleDescription =
    description ?? `Explorez l’environnement extérieur de ${targetLabel} dans Street View.`;

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
        <div className={styles.viewport}>
          {open ? (
            <iframe
              className={styles.iframe}
              src={embedUrl}
              title={`${title} — ${targetLabel}`}
              loading="lazy"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
            />
          ) : (
            <div className={styles.loading} aria-hidden="true">
              <p>Street View se chargera à l’ouverture.</p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
