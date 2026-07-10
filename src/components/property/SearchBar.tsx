import { useState } from "react";
import Search from "lucide-react/dist/esm/icons/search.js";

export function SearchBar({ defaultValue = "" }: { defaultValue?: string }) {
  const [query, setQuery] = useState(defaultValue);

  return (
    <form
      action="/sales"
      method="get"
      role="search"
      className="flex min-h-11 w-full items-center gap-2 rounded-md border border-border bg-white px-3 shadow-sm"
    >
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <label htmlFor="property-search" className="sr-only">
        Rechercher par région, département, ville ou code postal
      </label>
      <input
        id="property-search"
        name="q"
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Région, département, ville, code postal..."
        autoComplete="off"
        className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
      />
      <button
        type="submit"
        className="inline-flex h-8 items-center justify-center rounded-md bg-foreground px-3 text-xs font-semibold text-white transition-colors hover:bg-gold-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
      >
        Rechercher
      </button>
    </form>
  );
}
