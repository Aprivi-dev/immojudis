import Bath from "lucide-react/dist/esm/icons/bath.js";
import BedDouble from "lucide-react/dist/esm/icons/bed-double.js";
import Home from "lucide-react/dist/esm/icons/home.js";
import Ruler from "lucide-react/dist/esm/icons/ruler.js";
import type { Property } from "@/lib/property-types";
import { formatNumber, formatPropertyArea } from "@/lib/format";

export function PropertyStats({ property }: { property: Property }) {
  const stats = [
    {
      label: "Chambres",
      value: property.beds != null ? formatNumber(property.beds) : "—",
      icon: BedDouble,
    },
    {
      label: "Salles d'eau",
      value: property.baths != null ? formatNumber(property.baths) : "—",
      icon: Bath,
    },
    {
      label: "Surface",
      value: formatPropertyArea(property.sqft),
      icon: Ruler,
    },
    {
      label: "Type",
      value: property.propertyType ?? "Bien",
      icon: Home,
    },
  ];

  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {stats.map((stat) => {
        const Icon = stat.icon;
        return (
          <div key={stat.label} className="rounded-md border border-border bg-white p-4 shadow-sm">
            <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              <Icon className="h-4 w-4 text-gold-soft" />
              {stat.label}
            </dt>
            <dd className="mt-2 truncate text-lg font-semibold text-foreground">{stat.value}</dd>
          </div>
        );
      })}
    </dl>
  );
}
