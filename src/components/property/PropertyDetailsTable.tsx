import type { Property } from "@/lib/property-types";
import { AnimatedSection } from "./AnimatedSection";

export function PropertyDetailsTable({ property }: { property: Property }) {
  return (
    <AnimatedSection id="details" aria-labelledby="details-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">
          Caracteristiques
        </p>
        <h2 id="details-title" className="mt-2 font-display text-3xl text-foreground">
          Details du bien
        </h2>
      </div>
      <div className="mt-5 divide-y divide-border overflow-hidden rounded-md border border-border bg-white">
        {property.details.map((group) => (
          <div key={group.category} className="grid gap-0 md:grid-cols-[14rem_minmax(0,1fr)]">
            <h3 className="bg-muted/35 px-4 py-4 text-sm font-semibold text-foreground">
              {group.category}
            </h3>
            <dl className="divide-y divide-border">
              {group.items.map((item) => (
                <div
                  key={`${group.category}-${item.label}`}
                  className="grid gap-1 px-4 py-3 sm:grid-cols-2"
                >
                  <dt className="text-sm text-muted-foreground">{item.label}</dt>
                  <dd className="text-sm font-semibold text-foreground">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </AnimatedSection>
  );
}
