import type { Property } from "@/lib/property-types";
import { AnimatedSection } from "./AnimatedSection";
import { FactsGrid } from "./FactsGrid";

export function OverviewSection({ property }: { property: Property }) {
  return (
    <AnimatedSection id="overview" aria-labelledby="overview-title" className="space-y-5">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Vue d'ensemble
        </p>
        <h2 id="overview-title" className="mt-2 font-display text-3xl text-foreground">
          Description
        </h2>
      </div>
      <p className="max-w-3xl text-base leading-8 text-foreground">{property.description}</p>
      <FactsGrid facts={property.facts} />
    </AnimatedSection>
  );
}
