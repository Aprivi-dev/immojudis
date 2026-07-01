import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import MapPinned from "lucide-react/dist/esm/icons/map-pinned.js";
import TrainFront from "lucide-react/dist/esm/icons/train-front.js";
import type { Property } from "@/lib/property-types";
import { AnimatedSection } from "./AnimatedSection";

export function NeighborhoodSection({ property }: { property: Property }) {
  const items = [
    {
      label: "Ville",
      value: property.city,
      detail: `${property.region}, ${property.country}`,
      icon: Building2,
    },
    {
      label: "Adresse",
      value: property.postalCode,
      detail: property.address,
      icon: MapPinned,
    },
    {
      label: "Mobilite",
      value: "A verifier",
      detail: "Transports, acces et temps de trajet a confirmer depuis les donnees locales.",
      icon: TrainFront,
    },
  ];

  return (
    <AnimatedSection id="neighborhood" aria-labelledby="neighborhood-title">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-gold-soft">Quartier</p>
        <h2 id="neighborhood-title" className="mt-2 font-display text-3xl text-foreground">
          Environnement
        </h2>
      </div>
      <div className="mt-5 grid gap-3 md:grid-cols-3">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <article key={item.label} className="rounded-md border border-border bg-white p-4">
              <Icon className="h-5 w-5 text-gold-soft" />
              <h3 className="mt-3 text-sm font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                {item.label}
              </h3>
              <p className="mt-2 text-lg font-semibold text-foreground">{item.value}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.detail}</p>
            </article>
          );
        })}
      </div>
    </AnimatedSection>
  );
}
