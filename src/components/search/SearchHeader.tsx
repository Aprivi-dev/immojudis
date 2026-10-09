import dynamic from "next/dynamic";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import LayoutPanelLeft from "lucide-react/dist/esm/icons/layout-panel-left.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import LockKeyhole from "lucide-react/dist/esm/icons/lock-keyhole.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import { Link } from "@/lib/router-compat";
import { HOME_TYPE_OPTIONS, SORT_OPTIONS } from "@/lib/search/search-filters";
import { resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import type { SalesSearchParams, SearchSortKey } from "@/lib/search/search-url-state";
import type { SearchDraft } from "./search-page-state";

const LazyDateFilter = dynamic(() => import("./DateFilter").then((module) => module.DateFilter), {
  loading: () => <span className="inline-flex h-10 w-28 rounded-md border border-[#cbd5df]" />,
});
export function SearchHeader({
  draft,
  setDraft,
  activeFiltersCount,
  isLoading,
  isFetching,
  filtersOpen,
  savingAlert,
  alertsLocked,
  exportingCsv,
  csvExportLocked,
  wideMap,
  isDesktop = false,
  onFiltersOpenChange,
  onReset,
  onSaveSearch,
  onExportCsv,
  onToggleLayout,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  isLoading: boolean;
  isFetching: boolean;
  filtersOpen: boolean;
  savingAlert: boolean;
  alertsLocked: boolean;
  exportingCsv: boolean;
  csvExportLocked: boolean;
  wideMap: boolean;
  isDesktop?: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  onReset: () => void;
  onSaveSearch: () => void;
  onExportCsv: () => void;
  onToggleLayout: () => void;
}) {
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const header = headerRef.current;
    const main = header?.closest("main");
    if (!header || !main) return;
    const update = () =>
      main.style.setProperty("--sales-header-height", `${header.getBoundingClientRect().height}px`);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);
  return (
    <header
      ref={headerRef}
      className="sales-header sticky top-0 z-40 border-b border-[#132238]/10 bg-white"
    >
      <div className="flex min-h-16 items-center justify-between gap-4 border-b border-[#132238]/10 px-4 lg:px-5">
        <Link
          to="/"
          aria-label="ImmoJudis — accueil"
          className="shrink-0 font-display text-2xl font-semibold tracking-tight text-[#132238]"
        >
          Immo<span className="text-gold-text">Judis</span>
        </Link>
        {isDesktop ? (
          <div className="flex min-w-0 max-w-md flex-1">
            <GeographicSearch draft={draft} setDraft={setDraft} />
          </div>
        ) : null}
        <nav
          aria-label="Navigation du catalogue"
          className="flex items-center gap-4 text-xs font-semibold sm:text-sm"
        >
          <Link
            to="/sales"
            aria-current="page"
            className="hidden border-b-2 border-[#9c642b] py-5 xl:block"
          >
            Annonces
          </Link>
          <Link to="/favoris" className="py-4">
            Favoris
          </Link>
          <Link to="/comparaisons" className="py-4">
            Comparaisons
          </Link>
          <Link to="/accompagnement" className="hidden py-4 sm:block">
            Offres
          </Link>
        </nav>
        <div className="hidden lg:flex">
          <LayoutToggle wideMap={wideMap} onToggle={onToggleLayout} />
        </div>
      </div>
      <div className="px-4 py-2.5 lg:px-5">
        <div className="flex flex-wrap items-center gap-2">
          {!isDesktop ? (
            <div className="flex min-w-0 flex-1">
              <GeographicSearch draft={draft} setDraft={setDraft} />
            </div>
          ) : null}
          <div className="hidden lg:flex flex-wrap items-center gap-2">
            <HomeTypeFilter draft={draft} setDraft={setDraft} />
            <PriceFilter draft={draft} setDraft={setDraft} />
            <LazyDateFilter draft={draft} setDraft={setDraft} />
          </div>
          <button
            type="button"
            aria-label="Filtres avancés"
            aria-expanded={filtersOpen}
            onClick={() => onFiltersOpenChange(!filtersOpen)}
            className="inline-flex min-h-11 items-center gap-2 rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-semibold hover:bg-[#f8f9fa]"
          >
            <SlidersHorizontal className="h-4 w-4" />
            <span className="hidden sm:inline">Tous les filtres</span>
            <span className="sm:hidden">Filtres</span>
            {activeFiltersCount > 0 && (
              <span className="rounded-full bg-[#132238] px-2 py-0.5 text-xs text-white">
                {activeFiltersCount}
              </span>
            )}
          </button>
          {activeFiltersCount > 0 && (
            <button
              type="button"
              onClick={onReset}
              className="hidden min-h-11 px-2 text-xs font-semibold text-[#526170] underline underline-offset-4 lg:block"
            >
              Effacer les filtres
            </button>
          )}
          <div className="ml-auto hidden items-center gap-2 lg:flex">
            <CsvExportButton
              exporting={exportingCsv}
              locked={csvExportLocked}
              onClick={onExportCsv}
            />
            <SaveSearchButton saving={savingAlert} locked={alertsLocked} onClick={onSaveSearch} />
          </div>
        </div>
        {isFetching && !isLoading && (
          <p role="status" className="sr-only">
            Mise à jour des résultats
          </p>
        )}
      </div>
    </header>
  );
}

export function GeographicSearch({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  const selected = draft.city || draft.query || draft.department;
  const [value, setValue] = useState(selected);
  const [open, setOpen] = useState(false);
  useEffect(() => setValue(selected), [selected]);
  const scope = resolveFrenchGeoSearch(value);
  const kind =
    scope.kind === "text"
      ? "Ville"
      : scope.kind === "region"
        ? "Région"
        : scope.kind === "department"
          ? "Département"
          : "Code postal";
  function apply() {
    const text = value.trim();
    setDraft((c) => ({
      ...c,
      city: scope.kind === "text" ? text : "",
      query: scope.kind !== "text" ? text : "",
      department: "",
    }));
    setOpen(false);
  }
  return (
    <form
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        apply();
      }}
      className="relative flex min-w-0 basis-0 flex-1 items-center gap-1 rounded-md border border-[#cbd5df] bg-white focus-within:ring-2 focus-within:ring-[#c98d45] sm:basis-auto sm:flex-1"
    >
      <SearchIcon className="ml-3 h-5 w-5 shrink-0" />
      <input
        aria-label="Ville, département ou région"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}
        placeholder="Ville, département ou région"
        autoComplete="off"
        className="h-11 w-full min-w-0 bg-transparent px-2 text-sm outline-none"
      />
      <button
        type="submit"
        aria-label="Rechercher la localisation"
        className="mr-1 grid h-10 w-10 shrink-0 place-items-center rounded hover:bg-[#eef3f8]"
      >
        <SearchIcon className="h-4 w-4" />
      </button>
      {open && value.trim() && value !== selected && (
        <div className="absolute inset-x-0 top-full z-50 mt-2 rounded-md border bg-white p-2 shadow-lg">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={apply}
            className="w-full rounded px-3 py-3 text-left text-sm hover:bg-[#eef3f8]"
          >
            <strong>{value}</strong>
            <span className="ml-2 text-[#526170]">{kind}</span>
          </button>
        </div>
      )}
    </form>
  );
}

export function PriceFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <span className="px-3 text-sm font-bold text-[#132238]">Mise à prix</span>
      <input
        aria-label="Prix minimum"
        inputMode="numeric"
        value={draft.minPrice}
        onChange={(event) => setDraft((current) => ({ ...current, minPrice: event.target.value }))}
        placeholder="min"
        className="h-full w-20 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
      <input
        aria-label="Prix maximum"
        inputMode="numeric"
        value={draft.maxPrice}
        onChange={(event) => setDraft((current) => ({ ...current, maxPrice: event.target.value }))}
        placeholder="max"
        className="h-full w-20 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
    </div>
  );
}

export function BedsBathsFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <span className="px-3 text-sm font-bold text-[#132238]">Chambres / bains</span>
      <input
        aria-label="Nombre minimum de chambres"
        inputMode="numeric"
        value={draft.minBeds}
        onChange={(event) => setDraft((current) => ({ ...current, minBeds: event.target.value }))}
        placeholder="ch."
        className="h-full w-16 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
      <input
        aria-label="Nombre minimum de salles de bain"
        inputMode="numeric"
        value={draft.minBaths}
        onChange={(event) => setDraft((current) => ({ ...current, minBaths: event.target.value }))}
        placeholder="sdb"
        className="h-full w-16 border-l border-[#d6e0dc] bg-transparent px-2 text-sm font-semibold outline-none"
      />
    </div>
  );
}

export function HomeTypeFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <label className="relative inline-flex h-10 shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <Building2 className="ml-3 h-4 w-4 text-[#5b6878]" />
      <span className="sr-only">Type de bien</span>
      <select
        value={draft.homeTypes[0] ?? "all"}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            homeTypes: event.target.value === "all" ? [] : [event.target.value],
          }))
        }
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-[#132238] outline-none"
      >
        <option value="all">Tous biens</option>
        {HOME_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-[#5b6878]" />
    </label>
  );
}

export function SortDropdown({
  preview = false,
  hasCenter = false,
  sort,
  onChange,
}: {
  preview?: boolean;
  hasCenter?: boolean;
  sort: SearchSortKey;
  onChange: (sort: SearchSortKey) => void;
}) {
  return (
    <label className="relative inline-flex h-10 shrink-0 items-center rounded-md border border-[#cbd5df] bg-white shadow-sm">
      <ArrowUpDown className="ml-3 h-4 w-4 text-[#5b6878]" />
      <span className="sr-only">Tri</span>
      <select
        value={sort}
        onChange={(event) => onChange(event.target.value as SearchSortKey)}
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-[#132238] outline-none"
      >
        {SORT_OPTIONS.filter(
          (option) =>
            !(preview && option.value === "beds_desc") &&
            (option.value !== "distance" || hasCenter),
        ).map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-[#5b6878]" />
    </label>
  );
}

export function SaveSearchButton({
  saving,
  locked,
  onClick,
}: {
  saving: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md bg-[#132238] px-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-[#263c58] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#c98d45] disabled:cursor-not-allowed disabled:opacity-60"
    >
      {saving ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : locked ? (
        <LockKeyhole className="h-4 w-4" />
      ) : (
        <Bell className="h-4 w-4" />
      )}
      {locked ? "Créer une alerte · Analyse" : "Créer une alerte"}
    </button>
  );
}

export function CsvExportButton({
  exporting,
  locked,
  onClick,
}: {
  exporting: boolean;
  locked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={exporting}
      title={locked ? "Export CSV réservé au plan Analyse" : "Exporter les résultats en CSV"}
      className={`inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-extrabold shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] disabled:cursor-not-allowed disabled:opacity-60 ${
        locked
          ? "border-[#d6e0dc] bg-white text-[#5b6878]"
          : "border-[#0f766e] bg-white text-[#0f766e] hover:bg-[#eefaf3]"
      }`}
    >
      {exporting ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      CSV
    </button>
  );
}

export function LayoutToggle({ wideMap, onToggle }: { wideMap: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="hidden h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[#cbd5df] bg-white px-3 text-sm font-bold text-[#132238] shadow-sm transition-colors hover:border-[#0f766e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0f766e] lg:inline-flex"
      aria-label={wideMap ? "Afficher plus de résultats" : "Afficher plus de carte"}
      title={wideMap ? "Afficher plus de résultats" : "Afficher plus de carte"}
    >
      <LayoutPanelLeft className="h-4 w-4" />
      {wideMap ? "Plus de résultats" : "Agrandir la carte"}
    </button>
  );
}

export function ResultsSummary({
  search,
  displayCount,
  hasLocalFilters,
  isLoading,
  hasError = false,
  geocoding,
}: {
  search: SalesSearchParams;
  displayCount: number;
  hasLocalFilters: boolean;
  isLoading: boolean;
  hasError?: boolean;
  geocoding: boolean;
}) {
  const location = search.city || search.department || search.query || "France entière";
  return (
    <div className="min-w-0 px-4 py-4 sm:px-5" aria-live="polite">
      <p className="mb-1 text-[10px] font-bold uppercase tracking-[0.16em] text-gold-text">
        Le catalogue des enchères
      </p>
      <h1 className="font-display text-[1.65rem] font-semibold leading-tight">
        {location === "France entière" ? "Les ventes immobilières" : `Les ventes à ${location}`}
      </h1>
      <p className="mt-1 text-sm text-[#526170]">
        {isLoading
          ? "Recherche en cours…"
          : hasError
            ? "Catalogue momentanément indisponible"
            : `${displayCount.toLocaleString("fr-FR")} annonce${displayCount === 1 ? "" : "s"}`}
        {" · "}
        {search.viewport ? "Zone sélectionnée" : location}
        {hasLocalFilters ? " · filtres sur la page affichée" : ""}
        {geocoding ? " · localisation en cours" : ""}
      </p>
    </div>
  );
}

export function InlineTextFilter({
  label,
  icon: Icon,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-[#cbd5df] px-3">
      <Icon className="h-4 w-4 shrink-0" />
      <span className="sr-only">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
      />
    </label>
  );
}
