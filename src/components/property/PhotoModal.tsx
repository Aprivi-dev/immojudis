import { useEffect, useMemo, useRef, useState } from "react";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import X from "lucide-react/dist/esm/icons/x.js";
import type { PropertyPhoto } from "@/lib/property-types";
import { PropertyImage } from "./PropertyImage";

type PhotoModalProps = {
  photos: PropertyPhoto[];
  initialIndex: number;
  onClose: () => void;
};

export function PhotoModal({ photos, initialIndex, onClose }: PhotoModalProps) {
  const [index, setIndex] = useState(initialIndex);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const count = photos.length;
  const current = photos[index];
  const title = useMemo(() => `${index + 1} / ${count}`, [count, index]);

  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = originalOverflow;
      previousFocus.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setIndex((currentIndex) => (currentIndex + 1) % count);
      if (event.key === "ArrowLeft") {
        setIndex((currentIndex) => (currentIndex - 1 + count) % count);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [count, onClose]);

  if (!current) return null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Galerie photos plein ecran"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-[#07111f] text-white outline-none"
    >
      <div className="flex min-h-14 items-center justify-between border-b border-white/10 px-4 sm:px-6">
        <div className="text-sm font-semibold">{title}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer la galerie"
          className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-md border border-white/15 bg-white/8 transition-colors hover:bg-white/16 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        <PropertyImage
          src={current.url}
          alt={current.alt}
          priority
          className="mx-auto h-full max-h-[calc(100vh-8rem)] w-full object-contain"
        />
        {count > 1 && (
          <>
            <button
              type="button"
              onClick={() => setIndex((currentIndex) => (currentIndex - 1 + count) % count)}
              aria-label="Photo precedente"
              className="absolute left-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/45 transition-colors hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <ChevronLeft className="h-6 w-6" />
            </button>
            <button
              type="button"
              onClick={() => setIndex((currentIndex) => (currentIndex + 1) % count)}
              aria-label="Photo suivante"
              className="absolute right-3 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/15 bg-black/45 transition-colors hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <ChevronRight className="h-6 w-6" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
