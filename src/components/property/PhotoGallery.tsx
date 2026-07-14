import { useState } from "react";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ImageOff from "lucide-react/dist/esm/icons/image-off.js";
import Navigation2 from "lucide-react/dist/esm/icons/navigation-2.js";
import { MapboxPreviewButton } from "@/components/MapboxPreviewButton";
import { PhotoCarouselDialog, type CarouselImage } from "@/components/PhotoCarouselDialog";
import { RotatingCamera360 } from "@/components/RotatingCamera360";
import type { PropertyPhoto } from "@/lib/property-types";
import { cn } from "@/lib/utils";
import { PropertyImage } from "./PropertyImage";

export function PhotoGallery({
  photos,
  title,
  address,
  location,
}: {
  photos: PropertyPhoto[];
  title: string;
  address: string;
  location?: { lat: number; lng: number };
}) {
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const featured = photos[0];
  const thumbnails = photos.slice(1, 5);
  const carouselImages: CarouselImage[] = photos.map((photo, index) => ({
    id: photo.id,
    url: photo.url,
    alt: photo.alt || `Photo ${index + 1} de ${title}`,
  }));

  if (!featured) {
    return (
      <section
        aria-label={`Photos de ${title}`}
        className="flex min-h-[22rem] items-center justify-center rounded-none bg-muted text-center"
      >
        <div className="px-6">
          <span className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full border border-border bg-white text-muted-foreground">
            <ImageOff className="h-6 w-6" />
          </span>
          <h2 className="mt-4 text-lg font-semibold text-foreground">Photos indisponibles</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Les visuels seront affiches des qu'ils seront disponibles dans la base.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label={`Photos de ${title}`} className="relative bg-white">
      <div className="flex h-[clamp(16rem,78vw,22rem)] snap-x snap-mandatory overflow-x-auto overscroll-x-contain bg-white [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
        {photos.map((photo, index) => (
          <GalleryButton
            key={photo.id}
            photo={photo}
            index={index}
            onOpen={setModalIndex}
            className="h-full w-full max-w-full flex-none snap-start snap-always"
            priority={index === 0}
          />
        ))}
      </div>
      <div className="hidden min-h-[22rem] gap-1 overflow-hidden md:grid md:grid-cols-[minmax(0,1.55fr)_minmax(18rem,0.95fr)] md:rounded-none lg:min-h-[31rem]">
        <GalleryButton
          photo={featured}
          index={0}
          onOpen={setModalIndex}
          className="min-h-[22rem] md:min-h-[31rem]"
          priority
        />
        <div className="hidden grid-cols-2 gap-1 md:grid">
          {thumbnails.map((photo, index) => (
            <GalleryButton
              key={photo.id}
              photo={photo}
              index={index + 1}
              onOpen={setModalIndex}
              className="min-h-0"
            />
          ))}
        </div>
      </div>
      <button
        type="button"
        onClick={() => setModalIndex(0)}
        className="absolute bottom-4 right-4 z-20 inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-border bg-white px-3 text-sm font-semibold text-foreground shadow-lg transition-colors hover:border-gold/50 hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
      >
        <Camera className="h-4 w-4" />
        {photos.length} photo{photos.length > 1 ? "s" : ""}
      </button>
      {photos.length > 1 && <RotatingCamera360 className="absolute right-4 top-4 z-20" />}
      {location && (
        <div className="absolute left-4 top-4 z-20 md:bottom-4 md:top-auto">
          <MapboxPreviewButton
            mode="streetLevel"
            lat={location.lat}
            lng={location.lng}
            label="Vue rue"
            title="Vue rue Mapbox"
            description={address}
            ariaLabel={`Afficher la vue rue Mapbox pour ${address}`}
            icon={Navigation2}
            className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-white px-3 text-sm font-semibold text-foreground shadow-lg transition-colors hover:border-gold/50 hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          />
        </div>
      )}
      {modalIndex != null && (
        <PhotoCarouselDialog
          images={carouselImages}
          initialIndex={modalIndex}
          title={title}
          onClose={() => setModalIndex(null)}
        />
      )}
    </section>
  );
}

function GalleryButton({
  photo,
  index,
  onOpen,
  className,
  priority = false,
}: {
  photo: PropertyPhoto;
  index: number;
  onOpen: (index: number) => void;
  className?: string;
  priority?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      className={cn(
        "group relative block cursor-pointer overflow-hidden bg-muted text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold",
        className,
      )}
      aria-label={`Ouvrir la photo ${index + 1}`}
    >
      <PropertyImage
        src={photo.url}
        alt={photo.alt}
        priority={priority}
        className="transition duration-300 group-hover:brightness-95"
      />
    </button>
  );
}
