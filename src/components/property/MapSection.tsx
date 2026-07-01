import { lazy, Suspense } from "react";
import type { Property } from "@/lib/property-types";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedSection } from "./AnimatedSection";

const PropertyMapCanvas = lazy(() =>
  import("./PropertyMapCanvas").then((module) => ({ default: module.PropertyMapCanvas })),
);

export function MapSection({ property }: { property: Property }) {
  return (
    <AnimatedSection id="map" aria-labelledby="map-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Localisation
        </p>
        <h2 id="map-title" className="mt-2 font-display text-3xl text-foreground">
          Carte
        </h2>
      </div>
      <div className="mt-5">
        <Suspense fallback={<Skeleton className="h-[22rem] w-full rounded-md" />}>
          <PropertyMapCanvas property={property} />
        </Suspense>
      </div>
    </AnimatedSection>
  );
}
