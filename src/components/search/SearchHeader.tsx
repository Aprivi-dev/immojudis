import * as PopoverPrimitive from "@radix-ui/react-popover";
import dynamic from "next/dynamic";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import ArrowUpDown from "lucide-react/dist/esm/icons/arrow-up-down.js";
import Bell from "lucide-react/dist/esm/icons/bell.js";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Download from "lucide-react/dist/esm/icons/download.js";
import LayoutPanelLeft from "lucide-react/dist/esm/icons/layout-panel-left.js";
import LoaderCircle from "lucide-react/dist/esm/icons/loader-circle.js";
import SearchIcon from "lucide-react/dist/esm/icons/search.js";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal.js";
import { SiteHeader } from "@/components/SiteHeader";
import {
  ANALYSIS_ONLY_SORT_KEYS,
  HOME_TYPE_OPTIONS,
  SORT_OPTIONS,
} from "@/lib/search/search-filters";
import { resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import type { ResultsView } from "@/lib/search/results-view";
import type { SalesSearchParams, SearchSortKey } from "@/lib/search/search-url-state";
import { MobileFilterChips } from "./MobileFilterChips";
import { priceRangeError, type SearchDraft } from "./search-page-state";

const LazyDateFilter = dynamic(() => import("./DateFilter").then((module) => module.DateFilter), {
  // Same box as the real trigger (label, icons, padding): the toolbar must not
  // change width, and wrap, when the filter finishes loading.
  loading: () => (
    <span
      aria-hidden
      className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium"
    >
      <CalendarDays className="h-4 w-4" />
      Date de vente
      <ChevronDown className="h-4 w-4" />
    </span>
  ),
});
export function SearchHeader({
  draft,
  setDraft,
  activeFiltersCount,
  isLoading,
  isFetching,
  filtersOpen,
  savingAlert,
  exportingCsv,
  csvExportLocked,
  signedIn = false,
  dailyAlertsAllowed = false,
  emailRecapEnabled = false,
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
  exportingCsv: boolean;
  csvExportLocked: boolean;
  signedIn?: boolean;
  dailyAlertsAllowed?: boolean;
  /** Le consentement à l'email récapitulatif est déjà donné : on ne le redemande pas. */
  emailRecapEnabled?: boolean;
  wideMap: boolean;
  isDesktop?: boolean;
  onFiltersOpenChange: (open: boolean) => void;
  onReset: () => void;
  onSaveSearch: (options?: SaveSearchOptions) => void;
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
    <SiteHeader
      theme="light"
      placement="sticky"
      headerRef={headerRef}
      // L'en-tête ne reste collé en haut de l'écran qu'à partir de `lg` : sur mobile il défile avec la
      // page et rend sa place à la liste (`static` l'emporte sur le `sticky` de `SiteHeader`).
      className="sales-header static lg:sticky"
      center={isDesktop ? <GeographicSearch draft={draft} setDraft={setDraft} /> : undefined}
      belowBar={
        <div className="border-t border-border px-4 py-2.5 lg:px-5">
          <div className="flex flex-wrap items-center gap-2">
            {!isDesktop ? (
              <div className="flex min-w-0 flex-1">
                <GeographicSearch draft={draft} setDraft={setDraft} />
              </div>
            ) : null}
            {!isDesktop ? (
              <SaveSearchButton
                compact
                saving={savingAlert}
                signedIn={signedIn}
                dailyAllowed={dailyAlertsAllowed}
                emailRecapEnabled={emailRecapEnabled}
                onClick={onSaveSearch}
              />
            ) : null}
            <MobileFilterChips draft={draft} setDraft={setDraft} />
            <div className="hidden lg:flex flex-wrap items-center gap-2">
              <HomeTypeFilter draft={draft} setDraft={setDraft} />
              <PriceFilter draft={draft} setDraft={setDraft} />
              <LazyDateFilter draft={draft} setDraft={setDraft} />
            </div>
            <button
              type="button"
              aria-expanded={filtersOpen}
              onClick={() => onFiltersOpenChange(!filtersOpen)}
              className="hidden min-h-11 items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-semibold hover:bg-surface-tint lg:inline-flex"
            >
              <SlidersHorizontal className="h-4 w-4" />
              Tous les filtres
              {activeFiltersCount > 0 && (
                <span className="rounded-full bg-brand-navy px-2 py-0.5 text-xs text-white">
                  {activeFiltersCount}
                </span>
              )}
            </button>
            {activeFiltersCount > 0 && (
              <button
                type="button"
                onClick={onReset}
                className="inline-flex min-h-11 items-center px-2 text-xs font-semibold text-ink-soft underline underline-offset-4"
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
              <SaveSearchButton
                saving={savingAlert}
                signedIn={signedIn}
                dailyAllowed={dailyAlertsAllowed}
                emailRecapEnabled={emailRecapEnabled}
                onClick={onSaveSearch}
              />
              <LayoutToggle wideMap={wideMap} onToggle={onToggleLayout} />
            </div>
          </div>
          {isFetching && !isLoading && (
            <p role="status" className="sr-only">
              Mise à jour des résultats
            </p>
          )}
        </div>
      }
    />
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
      className="relative flex min-w-0 basis-0 flex-1 items-center gap-1 rounded-md border border-line bg-white focus-within:ring-2 focus-within:ring-gold sm:basis-auto sm:flex-1"
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
        className="mr-0.5 grid h-11 w-11 shrink-0 place-items-center rounded hover:bg-surface-tint"
      >
        <SearchIcon className="h-4 w-4" />
      </button>
      {open && value.trim() && value !== selected && (
        <div className="absolute inset-x-0 top-full z-50 mt-2 rounded-md border bg-white p-2 shadow-lg">
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={apply}
            className="w-full rounded px-3 py-3 text-left text-sm hover:bg-surface-tint"
          >
            <strong>{value}</strong>
            <span className="ml-2 text-ink-soft">{kind}</span>
          </button>
        </div>
      )}
    </form>
  );
}

export function PriceFilter({
  draft,
  setDraft,
  stacked = false,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  /** Dans le panneau de filtres : un libellé visible au-dessus de chaque champ. */
  stacked?: boolean;
}) {
  // Minimum au-dessus du maximum : la recherche ne trouverait rien, on le dit à côté des champs.
  const rangeError = priceRangeError(draft);
  const invalid = rangeError ? true : undefined;
  const rangeMessage = rangeError ? (
    <p role="alert" className="text-sm font-semibold text-danger">
      {rangeError}
    </p>
  ) : null;
  if (stacked) {
    return (
      <div className="grid gap-2">
        <div className="grid grid-cols-2 gap-3">
          <StackedField label="Minimum (€)">
            <input
              inputMode="numeric"
              value={draft.minPrice}
              aria-invalid={invalid}
              onChange={(event) =>
                setDraft((current) => ({ ...current, minPrice: event.target.value }))
              }
              placeholder="Aucun"
              className="form-input h-11"
            />
          </StackedField>
          <StackedField label="Maximum (€)">
            <input
              inputMode="numeric"
              value={draft.maxPrice}
              aria-invalid={invalid}
              onChange={(event) =>
                setDraft((current) => ({ ...current, maxPrice: event.target.value }))
              }
              placeholder="Aucun"
              className="form-input h-11"
            />
          </StackedField>
        </div>
        {rangeMessage}
      </div>
    );
  }
  return (
    <>
      <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-line bg-white shadow-sm">
        <span className="px-3 text-sm font-bold text-brand-navy">Mise à prix</span>
        <input
          aria-label="Prix minimum"
          inputMode="numeric"
          value={draft.minPrice}
          aria-invalid={invalid}
          onChange={(event) =>
            setDraft((current) => ({ ...current, minPrice: event.target.value }))
          }
          placeholder="min"
          className="h-full w-20 border-l border-line-soft bg-transparent px-2 text-sm font-semibold outline-none"
        />
        <input
          aria-label="Prix maximum"
          inputMode="numeric"
          value={draft.maxPrice}
          aria-invalid={invalid}
          onChange={(event) =>
            setDraft((current) => ({ ...current, maxPrice: event.target.value }))
          }
          placeholder="max"
          className="h-full w-20 border-l border-line-soft bg-transparent px-2 text-sm font-semibold outline-none"
        />
      </div>
      {rangeMessage}
    </>
  );
}

function StackedField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-semibold text-brand-navy">{label}</span>
      {children}
    </label>
  );
}

export function BedsBathsFilter({
  draft,
  setDraft,
  stacked = false,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  stacked?: boolean;
}) {
  if (stacked) {
    return (
      <div className="grid grid-cols-2 gap-3">
        <StackedField label="Chambres minimum">
          <input
            inputMode="numeric"
            value={draft.minBeds}
            onChange={(event) =>
              setDraft((current) => ({ ...current, minBeds: event.target.value }))
            }
            placeholder="Aucun"
            className="form-input h-11"
          />
        </StackedField>
        <StackedField label="Salles de bain minimum">
          <input
            inputMode="numeric"
            value={draft.minBaths}
            onChange={(event) =>
              setDraft((current) => ({ ...current, minBaths: event.target.value }))
            }
            placeholder="Aucun"
            className="form-input h-11"
          />
        </StackedField>
      </div>
    );
  }
  return (
    <div className="inline-flex h-10 shrink-0 items-center overflow-hidden rounded-md border border-line bg-white shadow-sm">
      <span className="px-3 text-sm font-bold text-brand-navy">Chambres / bains</span>
      <input
        aria-label="Nombre minimum de chambres"
        inputMode="numeric"
        value={draft.minBeds}
        onChange={(event) => setDraft((current) => ({ ...current, minBeds: event.target.value }))}
        placeholder="ch."
        className="h-full w-16 border-l border-line-soft bg-transparent px-2 text-sm font-semibold outline-none"
      />
      <input
        aria-label="Nombre minimum de salles de bain"
        inputMode="numeric"
        value={draft.minBaths}
        onChange={(event) => setDraft((current) => ({ ...current, minBaths: event.target.value }))}
        placeholder="sdb"
        className="h-full w-16 border-l border-line-soft bg-transparent px-2 text-sm font-semibold outline-none"
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
    <label className="relative inline-flex min-h-11 shrink-0 items-center rounded-md border border-line bg-white shadow-sm">
      <Building2 className="ml-3 h-4 w-4 text-ink-soft" />
      <span className="sr-only">Type de bien</span>
      <select
        value={draft.homeTypes[0] ?? "all"}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            homeTypes: event.target.value === "all" ? [] : [event.target.value],
          }))
        }
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-brand-navy outline-none"
      >
        <option value="all">Tous biens</option>
        {HOME_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-ink-soft" />
    </label>
  );
}

export function SortDropdown({
  preview = false,
  hasCenter = false,
  investmentScore = false,
  sort,
  onChange,
}: {
  preview?: boolean;
  hasCenter?: boolean;
  /** Offre Analyse : propose aussi le tri par score d'investissement (absent ailleurs). */
  investmentScore?: boolean;
  sort: SearchSortKey;
  onChange: (sort: SearchSortKey) => void;
}) {
  return (
    <label className="relative inline-flex min-h-11 shrink-0 items-center rounded-md border border-line bg-white shadow-sm">
      <ArrowUpDown className="ml-3 h-4 w-4 text-ink-soft" />
      <span className="sr-only">Tri</span>
      <select
        value={sort}
        onChange={(event) => onChange(event.target.value as SearchSortKey)}
        className="h-full cursor-pointer appearance-none bg-transparent py-0 pl-2 pr-9 text-sm font-bold text-brand-navy outline-none"
      >
        {SORT_OPTIONS.filter(
          (option) =>
            !(preview && option.value === "beds_desc") &&
            !(!investmentScore && ANALYSIS_ONLY_SORT_KEYS.includes(option.value)),
        ).map((option) => {
          // Sans adresse, il n'y a rien à mesurer : l'option reste visible mais grisée.
          const unavailable = option.value === "distance" && !hasCenter;
          return (
            <option key={option.value} value={option.value} disabled={unavailable}>
              {unavailable ? `${option.label} (saisissez une adresse)` : option.label}
            </option>
          );
        })}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 h-4 w-4 text-ink-soft" />
    </label>
  );
}

/**
 * Raccourci visible à côté du tri par défaut (« Mieux renseignées d’abord ») : un appui trie par
 * date de vente (la plus proche d'abord), un second appui revient au classement par défaut.
 */
export const SORT_BY_DATE_SHORTCUT_LABEL = "Trier par date de vente";

export function SortByDateShortcut({
  sort,
  onChange,
}: {
  sort: SearchSortKey;
  onChange: (sort: SearchSortKey) => void;
}) {
  const active = sort === "sale_date_asc";
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => onChange(active ? "relevance" : "sale_date_asc")}
      className={`inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-md border px-3 text-sm font-bold shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft ${
        active
          ? "border-brand-navy bg-brand-navy text-white"
          : "border-line bg-white text-brand-navy hover:border-gold"
      }`}
    >
      <CalendarDays className="h-4 w-4" aria-hidden />
      {SORT_BY_DATE_SHORTCUT_LABEL}
    </button>
  );
}

const RESULTS_VIEW_OPTIONS = [
  { value: "cards", label: "Cartes" },
  { value: "table", label: "Tableau" },
] as const satisfies readonly { value: ResultsView; label: string }[];

/**
 * « Cartes / Tableau » : l'affichage des résultats. Réservé à l'écran large (≥ lg), où le tableau
 * existe ; en dessous, la liste reste en cartes et ce choix n'est pas proposé.
 */
export function ResultsViewToggle({
  view,
  onChange,
}: {
  view: ResultsView;
  onChange: (view: ResultsView) => void;
}) {
  return (
    <fieldset className="hidden min-w-0 border-0 p-0 lg:block">
      <legend className="sr-only">Affichage des résultats</legend>
      <div className="inline-flex overflow-hidden rounded-md border border-line bg-white shadow-sm">
        {RESULTS_VIEW_OPTIONS.map(({ value, label }) => {
          const active = view === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(value)}
              className={`inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-1.5 px-3 text-sm font-bold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold-soft ${
                active
                  ? "bg-brand-navy text-white"
                  : "bg-white text-brand-navy hover:bg-surface-tint"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export type AlertFrequencyChoice = "daily" | "weekly";

export type SaveSearchOptions = {
  frequency: AlertFrequencyChoice;
  /** Case « email récapitulatif » cochée : le consentement est donné à la création de l'alerte. */
  emailRecap?: boolean;
};

export function SaveSearchButton({
  saving,
  compact = false,
  signedIn = false,
  dailyAllowed = false,
  emailRecapEnabled = false,
  label = "Créer une alerte",
  onClick,
}: {
  saving: boolean;
  compact?: boolean;
  /** Texte du bouton (hors version compacte). */
  label?: string;
  /** Connecté : on propose le choix de la fréquence ; sinon on envoie vers la connexion. */
  signedIn?: boolean;
  dailyAllowed?: boolean;
  emailRecapEnabled?: boolean;
  onClick: (options?: SaveSearchOptions) => void;
}) {
  const [open, setOpen] = useState(false);
  // Jamais pré-cochée : l'email part seulement si la personne le demande.
  const [emailRecap, setEmailRecap] = useState(false);
  // The free alert sends one weekly email; the daily digest belongs to Analyse.
  const [frequency, setFrequency] = useState<AlertFrequencyChoice>(
    dailyAllowed ? "daily" : "weekly",
  );
  const button = (
    <button
      type="button"
      disabled={saving}
      aria-label={compact ? "Créer une alerte" : undefined}
      title="Créer une alerte à partir de cette recherche"
      onClick={signedIn ? undefined : () => onClick()}
      className={`inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md bg-brand-navy text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-navy-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:bg-surface-tint disabled:text-ink-soft ${
        compact ? "size-11" : "h-10 px-3"
      }`}
    >
      {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
      {compact ? null : label}
    </button>
  );
  if (!signedIn) return button;
  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger asChild>{button}</PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="end"
          sideOffset={8}
          className="z-[70] w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-white p-4 text-sm text-foreground shadow-xl outline-none"
        >
          <p className="font-display text-xl font-semibold">Créer une alerte</p>
          <p className="mt-1 text-ink-soft">
            Les nouvelles ventes qui correspondent à cette recherche apparaissent dans vos alertes.
            Vous pouvez aussi les recevoir dans un seul email récapitulatif.
          </p>
          <fieldset className="mt-3">
            <legend className="mb-1 font-semibold">Fréquence</legend>
            <label
              className={`flex min-h-11 items-center gap-2 ${dailyAllowed ? "cursor-pointer" : "text-ink-soft"}`}
            >
              <input
                type="radio"
                name="alert-frequency"
                disabled={!dailyAllowed}
                checked={frequency === "daily"}
                onChange={() => setFrequency("daily")}
              />
              Quotidienne
              {dailyAllowed ? null : <span className="text-xs">(offre Analyse)</span>}
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2">
              <input
                type="radio"
                name="alert-frequency"
                checked={frequency === "weekly"}
                onChange={() => setFrequency("weekly")}
              />
              Hebdomadaire
            </label>
          </fieldset>
          {emailRecapEnabled ? (
            <p className="mt-2 text-xs text-ink-soft">
              L’email récapitulatif est activé. Vous pouvez le désactiver depuis la cloche des
              notifications.
            </p>
          ) : (
            <label className="mt-2 flex min-h-11 cursor-pointer items-start gap-2">
              <input
                type="checkbox"
                checked={emailRecap}
                onChange={(event) => setEmailRecap(event.target.checked)}
                className="mt-1"
              />
              <span>
                {frequency === "daily"
                  ? "Recevoir un email récapitulatif chaque jour"
                  : "Recevoir un email récapitulatif chaque semaine"}
                <span className="block text-xs text-ink-soft">
                  Facultatif. Vous pouvez vous désinscrire à tout moment.
                </span>
              </span>
            </label>
          )}
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              onClick({ frequency, emailRecap: !emailRecapEnabled && emailRecap });
              setEmailRecap(false);
            }}
            className="mt-3 inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-md bg-gold font-semibold text-brand-navy hover:bg-gold-light focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            Créer l’alerte
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
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
      title={locked ? "Export CSV réservé à l'offre Analyse" : "Exporter les résultats en CSV"}
      className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-semibold text-brand-navy shadow-sm transition-colors hover:border-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-not-allowed disabled:bg-surface-tint disabled:text-ink-soft"
    >
      {exporting ? (
        <LoaderCircle className="h-4 w-4 animate-spin" />
      ) : (
        <Download className="h-4 w-4" />
      )}
      Exporter en CSV
    </button>
  );
}

export function LayoutToggle({ wideMap, onToggle }: { wideMap: boolean; onToggle: () => void }) {
  const label = wideMap ? "Plus de résultats" : "Agrandir la carte";
  return (
    <button
      type="button"
      onClick={onToggle}
      className="hidden h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-semibold text-brand-navy shadow-sm transition-colors hover:border-brand-navy focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold 2xl:inline-flex"
    >
      <LayoutPanelLeft className="h-4 w-4" />
      {label}
    </button>
  );
}

/**
 * Hauteur de l'en-tête avec un titre sur DEUX lignes, réservée sous `sm`. À 412 px, le h1 tient
 * sur une ligne en Cormorant Garamond (348 px pour 348 px disponibles) mais sur deux dans la
 * police de secours, plus large (379 px) ; sur les écrans plus étroits, sur deux dans les deux.
 * Quand la police arrive après le premier affichage (4G), la ligne en trop disparaissait : tout
 * ce qui suit remontait de 33 px (CLS 0,03) et la photo de la première carte, déjà peinte, gardait
 * pour le LCP une surface rognée par le bas de l'écran (puis un second LCP quand elle était
 * recréée à l'hydratation). Valeur : py-4 (2 rem) + h1 de 2 × 2,0625 (1,65 rem, interligne 1,25)
 * + marge (0,25) + compteur (1,25) = 7,625 rem. Le surtitre n'est affiché qu'à partir de `sm`
 * (il prenait 1,1875 rem sur mobile : 0,9375 + marge 0,25) : la hauteur réservée ne le compte plus.
 */
const RESULTS_SUMMARY_MOBILE_MIN_HEIGHT = "min-h-[7.625rem] sm:min-h-0";

export function ResultsSummary({
  search,
  displayCount,
  hasLocalFilters,
  isLoading,
  hasError = false,
  geocoding,
  refreshing = false,
}: {
  search: SalesSearchParams;
  displayCount: number;
  hasLocalFilters: boolean;
  isLoading: boolean;
  hasError?: boolean;
  geocoding: boolean;
  /** La liste se met à jour (page, filtre) : un petit indicateur dans la ligne du compteur. */
  refreshing?: boolean;
}) {
  const location = search.city || search.department || search.query || "France entière";
  return (
    <div className={`min-w-0 px-4 py-4 sm:px-5 ${RESULTS_SUMMARY_MOBILE_MIN_HEIGHT}`}>
      <p className="mb-1 hidden text-[10px] font-bold uppercase tracking-[0.16em] text-gold-text sm:block">
        Le catalogue des enchères
      </p>
      <h1 className="font-display text-[1.65rem] font-semibold leading-tight">
        {location === "France entière"
          ? "Ventes immobilières aux enchères"
          : `Ventes immobilières aux enchères à ${location}`}
      </h1>
      <p className="mt-1 text-sm text-ink-soft">
        {/* Seul le compteur est annoncé aux lecteurs d'écran, pas tout l'en-tête. */}
        <span aria-live="polite">
          {isLoading
            ? "Recherche en cours…"
            : hasError
              ? "Catalogue momentanément indisponible"
              : `${displayCount.toLocaleString("fr-FR")} annonce${displayCount === 1 ? "" : "s"}`}
        </span>
        {/* Indicateur visuel seul (l'annonce « Mise à jour des résultats » existe pour les
            lecteurs d'écran) : plus petit que la ligne, il ne change pas sa hauteur. */}
        {refreshing ? (
          <span
            aria-hidden="true"
            data-testid="results-refreshing"
            className="ml-1.5 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-1px] motion-reduce:animate-none"
          />
        ) : null}
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
    <label className="grid min-w-0 gap-1.5 text-sm">
      <span className="font-semibold text-brand-navy">{label}</span>
      <span className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-line px-3 focus-within:ring-2 focus-within:ring-gold">
        <Icon className="h-4 w-4 shrink-0" />
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
      </span>
    </label>
  );
}
