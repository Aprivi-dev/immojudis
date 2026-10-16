"use client";

import { useEffect, useRef, useState, type ComponentProps, type SyntheticEvent } from "react";
import dynamic from "next/dynamic";
import ImageOff from "lucide-react/dist/esm/icons/image-off.js";
import { canOptimizeListingPhoto } from "@/lib/listing-photo-source";
import type { PhotoMirrorDisplay } from "@/lib/photo-mirror";

const Image = dynamic(() => import("next/image"));

const DEFAULT_SIZES = "(max-width: 767px) calc(100vw - 32px), (max-width: 1280px) 50vw, 720px";

type Props = Omit<ComponentProps<"img">, "src" | "alt"> & {
  src: string;
  alt: string;
  compactFallback?: boolean;
  /**
   * Notre copie de la photo (WebP déjà à la bonne taille), essayée en premier et servie telle
   * quelle, sans l'optimiseur. Si elle échoue, `src` (la source) prend le relais comme avant.
   */
  mirror?: PhotoMirrorDisplay | null;
  /** Called only when the original source has failed, after optimizer fallback. */
  onOriginalError?: () => void;
};

export function ListingPhoto(props: Props) {
  return <Photo key={`${props.src}|${props.mirror?.src ?? ""}`} {...props} />;
}

function Photo({
  src,
  alt,
  onError,
  onOriginalError,
  compactFallback = false,
  mirror,
  width,
  height,
  srcSet,
  sizes,
  ...props
}: Props) {
  const [failed, setFailed] = useState(false);
  const [originalOnly, setOriginalOnly] = useState(false);
  const [mirrorFailed, setMirrorFailed] = useState(false);
  const showMirror = Boolean(mirror) && !mirrorFailed;
  const optimized = canOptimizeListingPhoto(src) && !originalOnly;
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && !image.naturalWidth) {
      if (showMirror) setMirrorFailed(true);
      else if (optimized) setOriginalOnly(true);
      else {
        setFailed(true);
        onOriginalError?.();
      }
    }
  }, [onOriginalError, optimized, showMirror]);

  if (failed) {
    return (
      <span
        role={alt ? "img" : undefined}
        aria-label={alt ? `${alt} : indisponible` : undefined}
        aria-hidden={alt ? undefined : true}
        className="flex h-full min-h-20 w-full items-center justify-center bg-muted px-4 text-center text-sm text-foreground"
      >
        {compactFallback ? <ImageOff className="h-5 w-5" aria-hidden /> : "Photo indisponible"}
      </span>
    );
  }

  const imageProps = {
    ...props,
    src,
    alt,
    ref: imageRef,
    onError: (event: SyntheticEvent<HTMLImageElement>) => {
      if (showMirror) {
        // Étage 1 perdu : on retombe sur la source, comme si la copie n'avait jamais existé.
        setMirrorFailed(true);
        return;
      }
      if (optimized) setOriginalOnly(true);
      else {
        setFailed(true);
        onOriginalError?.();
      }
      onError?.(event);
    },
  };

  if (showMirror && mirror) {
    return (
      <img
        {...imageProps}
        key="mirror"
        src={mirror.src}
        srcSet={mirror.srcSet}
        width={width}
        height={height}
        sizes={sizes ?? DEFAULT_SIZES}
      />
    );
  }

  return optimized ? (
    <span className="relative block h-full w-full">
      <Image
        {...imageProps}
        fill
        sizes={sizes ?? DEFAULT_SIZES}
        loading={props.loading ?? (props.fetchPriority === "high" ? "eager" : "lazy")}
      />
    </span>
  ) : (
    <img {...imageProps} width={width} height={height} srcSet={srcSet} sizes={sizes} />
  );
}
