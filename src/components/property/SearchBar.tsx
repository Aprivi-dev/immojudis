import { useState } from "react";
import Search from "lucide-react/dist/esm/icons/search.js";

export function SearchBar({ defaultValue = "" }: { defaultValue?: string }) {
  const [query, setQuery] = useState(defaultValue);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    window.location.assign(trimmed ? `/sales?city=${encodeURIComponent(trimmed)}` : "/sales");
  };

  return (
    <form
      onSubmit={submit}
      role="search"
      className="flex min-h-11 w-full items-center gap-2 rounded-md border border-border bg-white px-3 shadow-sm"
    >
      <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
      <label htmlFor="property-search" className="sr-only">
        Rechercher une ville ou une adresse
      </label>
      <input
        id="property-search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Ville, adresse, code postal"
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
