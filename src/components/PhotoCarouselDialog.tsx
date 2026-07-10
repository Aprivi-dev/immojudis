import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ChevronLeft from "lucide-react/dist/esm/icons/chevron-left.js";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { cn } from "@/lib/utils";

export type CarouselImage = {
  id?: string;
  url: string;
  alt: string;
  source?: string | null;
};

type PhotoCarouselDialogProps = {
  images: CarouselImage[];
  initialIndex: number;
  title?: string;
  onClose: () => void;
};

export function PhotoCarouselDialog({
  images,
  initialIndex,
  title = "Photos du bien",
  onClose,
}: PhotoCarouselDialogProps) {
  const count = images.length;
  const [index, setIndex] = useState(() => clampIndex(initialIndex, count));
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const activeThumbnailRef = useRef<HTMLButtonElement | null>(null);
  const current = images[index];
  const counterLabel = useMemo(() => `${index + 1} / ${count}`, [count, index]);

  const goPrevious = useCallback(() => {
    setIndex((currentIndex) => (currentIndex - 1 + count) % count);
  }, [count]);

  const goNext = useCallback(() => {
    setIndex((currentIndex) => (currentIndex + 1) % count);
  }, [count]);

  useEffect(() => {
    setIndex(clampIndex(initialIndex, count));
  }, [count, initialIndex]);

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
      if (count <= 1) return;
      if (event.key === "ArrowRight") goNext();
      if (event.key === "ArrowLeft") goPrevious();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [count, goNext, goPrevious, onClose]);

  useEffect(() => {
    activeThumbnailRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [index]);

  if (!count || !current) return null;

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchStartX.current = event.changedTouches[0]?.clientX ?? null;
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const startX = touchStartX.current;
    touchStartX.current = null;
    if (startX == null || count <= 1) return;

    const deltaX = (event.changedTouches[0]?.clientX ?? startX) - startX;
    if (Math.abs(deltaX) < 48) return;
    if (deltaX < 0) goNext();
    else goPrevious();
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Galerie photos"
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex flex-col bg-[#07111f] text-white outline-none"
    >
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-white/10 px-3 sm:min-h-16 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-white/55">
            <Camera className="h-3.5 w-3.5" />
            Galerie
          </div>
          <h2 className="mt-0.5 truncate text-sm font-semibold text-white sm:text-base">{title}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full border border-white/12 bg-white/8 px-3 py-1 text-xs font-semibold tabular-nums text-white">
            {counterLabel}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer la galerie"
            className="inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-full border border-white/12 bg-white/8 transition-colors hover:bg-white/16 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_15rem] lg:grid-rows-1">
        <div
          className="relative min-h-0 bg-black/30"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
        >
          <div className="relative w-full lg:h-full">
            <img
              src={current.url}
              alt={current.alt}
              className="mx-auto block max-h-[calc(100vh-10.5rem)] max-w-full object-contain lg:h-full lg:max-h-[calc(100vh-4rem)] lg:w-full"
              loading="eager"
              decoding="async"
              referrerPolicy="no-referrer"
            />
            {count > 1 && (
              <>
                <button
                  type="button"
                  onClick={goPrevious}
                  aria-label="Photo précédente"
                  className="absolute left-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/12 bg-black/45 text-white shadow-lg backdrop-blur transition-colors hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:left-4"
                >
                  <ChevronLeft className="h-6 w-6" />
                </button>
                <button
                  type="button"
                  onClick={goNext}
                  aria-label="Photo suivante"
                  className="absolute right-2 top-1/2 inline-flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/12 bg-black/45 text-white shadow-lg backdrop-blur transition-colors hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white sm:right-4"
                >
                  <ChevronRight className="h-6 w-6" />
                </button>
              </>
            )}
          </div>
          {current.source && (
            <span className="absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-full border border-white/12 bg-black/45 px-3 py-1 text-xs font-medium text-white/82 backdrop-blur">
              Source · {current.source}
            </span>
          )}
        </div>

        <div className="min-h-0 border-t border-white/10 bg-[#0b1625] p-3 lg:border-l lg:border-t-0">
          <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] lg:grid lg:max-h-full lg:grid-cols-1 lg:overflow-y-auto lg:pb-0 [&::-webkit-scrollbar]:hidden">
            {images.map((image, thumbnailIndex) => (
              <button
                key={image.id ?? `${image.url}-${thumbnailIndex}`}
                ref={thumbnailIndex === index ? activeThumbnailRef : undefined}
                type="button"
                onClick={() => setIndex(thumbnailIndex)}
                aria-label={`Afficher la photo ${thumbnailIndex + 1}`}
                aria-current={thumbnailIndex === index}
                className={cn(
                  "relative h-16 w-24 shrink-0 cursor-pointer overflow-hidden rounded-md border bg-white/8 transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white lg:h-20 lg:w-full",
                  thumbnailIndex === index
                    ? "border-gold-soft ring-2 ring-gold-soft/45"
                    : "border-white/12 opacity-72 hover:opacity-100",
                )}
              >
                <img
                  src={image.url}
                  alt=""
                  className="h-full w-full object-cover"
                  loading={thumbnailIndex < 6 ? "eager" : "lazy"}
                  decoding="async"
                  referrerPolicy="no-referrer"
                />
                <span className="absolute bottom-1 right-1 rounded-full bg-black/55 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-white">
                  {thumbnailIndex + 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function clampIndex(index: number, count: number) {
  if (count <= 0) return 0;
  return Math.min(Math.max(index, 0), count - 1);
}
