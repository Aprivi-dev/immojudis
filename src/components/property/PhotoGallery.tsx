import { useState } from "react";
import Camera from "lucide-react/dist/esm/icons/camera.js";
import ImageOff from "lucide-react/dist/esm/icons/image-off.js";
import Navigation2 from "lucide-react/dist/esm/icons/navigation-2.js";
import Rotate3D from "lucide-react/dist/esm/icons/rotate-3d.js";
import { GoogleMapsPreviewButton } from "@/components/GoogleMapsPreviewButton";
import type { PropertyPhoto } from "@/lib/property-types";
import { cn } from "@/lib/utils";
import { PhotoModal } from "./PhotoModal";
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
  const mapLinks = location
    ? [
        {
          mode: "aerial3d" as const,
          label: "Vue 3D",
          title: "Vue 3D Google Maps",
          description: address,
          ariaLabel: `Afficher la vue 3D Google Maps de ${address}`,
          icon: Rotate3D,
        },
        {
          mode: "streetView" as const,
          label: "Street View",
          title: "Street View Google Maps",
          description: address,
          ariaLabel: `Afficher Street View Google Maps pour ${address}`,
          icon: Navigation2,
        },
      ]
    : [];

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
      <div className="flex h-[22rem] snap-x snap-mandatory overflow-x-auto bg-white [-webkit-overflow-scrolling:touch] [scrollbar-width:none] md:hidden [&::-webkit-scrollbar]:hidden">
        {photos.map((photo, index) => (
          <GalleryButton
            key={photo.id}
            photo={photo}
            index={index}
            onOpen={setModalIndex}
            className="h-full min-w-full shrink-0 snap-center"
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
      {mapLinks.length > 0 && (
        <div className="absolute left-4 top-4 z-20 flex flex-wrap gap-2 md:bottom-4 md:top-auto">
          {mapLinks.map(({ mode, label, title, description, ariaLabel, icon }) => (
            <GoogleMapsPreviewButton
              key={label}
              mode={mode}
              lat={location?.lat}
              lng={location?.lng}
              label={label}
              title={title}
              description={description}
              ariaLabel={ariaLabel}
              icon={icon}
              className="inline-flex min-h-10 items-center gap-2 rounded-md border border-border bg-white px-3 text-sm font-semibold text-foreground shadow-lg transition-colors hover:border-gold/50 hover:text-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            />
          ))}
        </div>
      )}
      {modalIndex != null && (
        <PhotoModal photos={photos} initialIndex={modalIndex} onClose={() => setModalIndex(null)} />
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
