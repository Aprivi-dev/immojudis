import { Link } from "@/lib/router-compat";
import Bath from "lucide-react/dist/esm/icons/bath.js";
import BedDouble from "lucide-react/dist/esm/icons/bed-double.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import type { Property } from "@/lib/property-types";
import { formatCurrency, formatPropertyArea } from "@/lib/format";
import { AnimatedSection } from "./AnimatedSection";
import { PropertyImage } from "./PropertyImage";

export function SimilarListings({ property }: { property: Property }) {
  const listings = property.similarListings ?? [];

  return (
    <AnimatedSection id="similar" aria-labelledby="similar-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Comparables
        </p>
        <h2 id="similar-title" className="mt-2 font-display text-3xl text-foreground">
          Biens similaires
        </h2>
      </div>
      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {listings.length ? (
          listings.map((listing) => (
            <Link
              key={listing.id}
              to="/properties/$id"
              params={{ id: listing.slug }}
              className="group overflow-hidden rounded-md border border-border bg-white shadow-sm transition-colors hover:border-gold/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
            >
              <div className="aspect-[4/3] overflow-hidden bg-muted">
                <PropertyImage
                  src={listing.photoUrl}
                  alt={`Bien similaire a ${listing.city}`}
                  className="transition duration-300 group-hover:brightness-95"
                />
              </div>
              <div className="p-4">
                <div className="text-lg font-semibold text-foreground">
                  {formatCurrency(listing.price, listing.currency)}
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">
                  {listing.address}, {listing.city}
                </p>
                <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <BedDouble className="h-3.5 w-3.5" />
                    {listing.beds ?? "—"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Bath className="h-3.5 w-3.5" />
                    {listing.baths ?? "—"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Ruler className="h-3.5 w-3.5" />
                    {formatPropertyArea(listing.sqft)}
                  </span>
                </div>
              </div>
            </Link>
          ))
        ) : (
          <div className="rounded-md border border-border bg-white p-5 text-sm text-muted-foreground md:col-span-3">
            Aucun bien similaire disponible dans les fixtures.
          </div>
        )}
      </div>
    </AnimatedSection>
  );
}
