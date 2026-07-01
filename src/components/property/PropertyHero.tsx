import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import type { Property } from "@/lib/property-types";
import { formatCompactAddress, formatCurrency } from "@/lib/format";
import { PhotoGallery } from "./PhotoGallery";
import { PropertyStats } from "./PropertyStats";

export function PropertyHero({ property }: { property: Property }) {
  const address = formatCompactAddress([
    property.address,
    property.postalCode,
    property.city,
    property.country,
  ]);

  return (
    <section className="bg-[#f7f5f1]">
      <PhotoGallery
        photos={property.photos}
        title={property.title}
        address={address}
        location={property.location}
      />
      <div className="mx-auto grid max-w-7xl gap-5 px-4 py-6 sm:px-6 lg:px-8">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <div>
            <div className="text-4xl font-bold tracking-tight text-foreground sm:text-5xl">
              {formatCurrency(property.price, property.currency)}
            </div>
            <h1 className="mt-3 font-display text-3xl leading-tight text-foreground sm:text-5xl">
              {property.title}
            </h1>
            <p className="mt-3 flex items-start gap-2 text-sm leading-relaxed text-muted-foreground sm:text-base">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-gold-soft" />
              <span>{address}</span>
            </p>
          </div>
          <div className="rounded-md border border-border bg-white p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Prix au ft²
            </div>
            <div className="mt-2 text-2xl font-semibold text-foreground">
              {property.pricePerSqft
                ? `${formatCurrency(property.pricePerSqft, property.currency)}/ft²`
                : "A calculer"}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              Prix indicatif selon la surface renseignee dans la fiche.
            </p>
          </div>
        </div>
        <PropertyStats property={property} />
      </div>
    </section>
  );
}
