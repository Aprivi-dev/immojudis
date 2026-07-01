import { Link } from "@/lib/router-compat";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.js";
import type { Property } from "@/lib/property-types";
import { SearchBar } from "./SearchBar";

export function PropertyHeader({ property }: { property: Property }) {
  return (
    <header className="border-b border-border bg-white/92 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <nav
            aria-label="Fil d'Ariane"
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <Link
              to="/"
              className="font-semibold text-foreground transition-colors hover:text-gold-soft"
            >
              Immojudis
            </Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <Link to="/sales" className="transition-colors hover:text-gold-soft">
              Biens
            </Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <span className="max-w-[18rem] truncate">{property.city}</span>
          </nav>
          <div className="w-full lg:max-w-md">
            <SearchBar defaultValue={property.city} />
          </div>
        </div>
      </div>
    </header>
  );
}
