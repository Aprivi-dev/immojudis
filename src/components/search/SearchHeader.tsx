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
import { PLAN_LIMITS } from "@/lib/plans";
import { resolveFrenchGeoSearch } from "@/lib/search/french-geo-search";
import type { ResultsView } from "@/lib/search/results-view";
import type { SearchSortKey } from "@/lib/search/search-url-state";
import { MobileFilterChips } from "./MobileFilterChips";
import { FORCED_COLORS_SELECTED } from "./forced-colors";
import { SaleTypeFilter } from "./SaleTypeFilter";
import { priceRangeError, type SearchDraft } from "./search-page-state";

const LazyDateFilter = dynamic(() => import("./DateFilter").then((module) => module.DateFilter), {
  // Same box as the real trigger (label, icons, padding): the toolbar must not
  // change width, and wrap, when the filter finishes loading.
  loading: () => (
    <span
      aria-hidden
      className="inline-flex min-h-11 items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-semibold text-brand-navy"
    >
      <CalendarDays className="h-4 w-4" />
      Date de vente
      <ChevronDown className="h-4 w-4" />
    </span>
  ),
});
/**
 * En-tête du site de /sales : la barre pleine largeur, qui défile avec la page (`static` l'emporte
 * sur le `sticky` de `SiteHeader`) ; c'est la barre de filtres qui reste à l'écran. Rendue AVANT le
 * `<main>` de la page (repère « bannière »), avec la région qui annonce la mise à jour des résultats.
 */
export function SalesSiteHeader({ refreshing }: { refreshing: boolean }) {
  return (
    <SiteHeader
      placement="sticky"
      className="sales-header static"
      belowBar={
        refreshing ? (
          <p role="status" className="sr-only">
            Mise à jour des résultats
          </p>
        ) : (
          // Région présente dès le départ (vide) : l'annonce suivante sera bien lue.
          <p role="status" className="sr-only" />
        )
      }
    />
  );
}

/**
 * Haut du contenu de /sales (maquette validée), sous l'en-tête du site (`SalesSiteHeader`) :
 * l'en-tête du catalogue (`intro` : titre, actions, suivi), puis UNE barre de filtres blanche qui
 * reste à l'écran au défilement (à partir de `lg`) : lieu, type de bien, mise à prix, date de
 * vente, tous les filtres, et dessous les types de vente en pastilles.
 *
 * Sur mobile, la barre défile avec la page : le champ du lieu (avec l'alerte), une rangée de
 * filtres qui défile (« Filtres », type de bien, mise à prix, date…), puis la rangée des types de
 * vente.
 *
 * La hauteur de la barre est écrite dans `--sales-header-height` (sur l'élément `main` de la page) : la carte et la
 * barre du comparateur se collent juste dessous.
 */
export function SearchHeader({
  draft,
  setDraft,
  activeFiltersCount,
  filtersOpen,
  savingAlert,
  signedIn = false,
  dailyAlertsAllowed = false,
  emailRecapEnabled = false,
  pepitesActive = false,
  signupLinks,
  freeAlertUsage = null,
  onAlertDialogOpen,
  isDesktop = false,
  intro,
  onFiltersOpenChange,
  onReset,
  onSaveSearch,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  filtersOpen: boolean;
  savingAlert: boolean;
  signedIn?: boolean;
  dailyAlertsAllowed?: boolean;
  /** Le consentement à l'email récapitulatif est déjà donné : on ne le redemande pas. */
  emailRecapEnabled?: boolean;
  /** Les pépites sont ouvertes au public : la pastille « Pépites seulement » est proposée. */
  pepitesActive?: boolean;
  /** Adresses d'inscription des pastilles réservées aux comptes (visiteur sans compte). */
  signupLinks?: { belowRange: string; noPointsToVerify: string };
  /** Alerte gratuite : alertes actives du compte (`used`) sur `limit`, quand c'est connu. */
  freeAlertUsage?: FreeAlertUsage | null;
  /** La fenêtre de création d'alerte s'ouvre (compte connecté) : de quoi lire l'usage de l'alerte gratuite. */
  onAlertDialogOpen?: () => void;
  isDesktop?: boolean;
  /** En-tête du catalogue, entre l'en-tête du site et la barre de filtres. */
  intro?: React.ReactNode;
  /** `trigger` : le bouton qui ouvre la fenêtre des filtres, où le focus reviendra à sa fermeture. */
  onFiltersOpenChange: (open: boolean, trigger?: HTMLElement) => void;
  onReset: () => void;
  onSaveSearch: (options?: SaveSearchOptions) => void;
}) {
  const barRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const bar = barRef.current;
    const main = bar?.closest("main");
    if (!bar || !main) return;
    const update = () =>
      main.style.setProperty("--sales-header-height", `${bar.getBoundingClientRect().height}px`);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  const filtersButtonLabel = (
    <>
      Tous les filtres
      {activeFiltersCount > 0 && (
        <span className="rounded-full bg-brand-navy px-2 py-0.5 text-xs text-white">
          {activeFiltersCount}
        </span>
      )}
    </>
  );
  return (
    <>
      {intro}
      <div
        ref={barRef}
        data-sales-filters=""
        className="z-30 bg-background py-2.5 lg:sticky lg:top-0"
      >
        {/* Une seule colonne bornée à la largeur de l'écran : les rangées qui défilent (filtres,
            types de vente) ne doivent pas élargir la grille. */}
        <div className="mx-auto grid max-w-[90rem] grid-cols-[minmax(0,1fr)] gap-2 px-4 lg:gap-3 lg:px-6">
          <div className="flex flex-wrap items-center gap-2 lg:rounded-lg lg:border lg:border-line-soft lg:bg-white lg:p-2">
            <div className="flex min-w-0 flex-[2_1_16rem]">
              <GeographicSearch draft={draft} setDraft={setDraft} />
            </div>
            {!isDesktop ? (
              <span className="lg:hidden">
                <SaveSearchButton
                  compact
                  saving={savingAlert}
                  signedIn={signedIn}
                  dailyAllowed={dailyAlertsAllowed}
                  emailRecapEnabled={emailRecapEnabled}
                  freeAlertUsage={dailyAlertsAllowed ? null : freeAlertUsage}
                  onOpen={onAlertDialogOpen}
                  onClick={onSaveSearch}
                />
              </span>
            ) : null}
            <div className="hidden min-w-0 flex-[3_1_34rem] flex-wrap items-center gap-2 lg:flex">
              <HomeTypeFilter draft={draft} setDraft={setDraft} />
              <PriceFilter draft={draft} setDraft={setDraft} />
              <LazyDateFilter draft={draft} setDraft={setDraft} />
              <button
                type="button"
                aria-expanded={filtersOpen}
                onClick={(event) => onFiltersOpenChange(!filtersOpen, event.currentTarget)}
                className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-semibold text-brand-navy hover:border-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
              >
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                {filtersButtonLabel}
              </button>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:hidden">
            <MobileFilterChips
              draft={draft}
              setDraft={setDraft}
              preview={!signedIn}
              pepitesActive={pepitesActive}
              signupLinks={signupLinks}
              activeFiltersCount={activeFiltersCount}
              filtersOpen={filtersOpen}
              onOpenFilters={(trigger) => onFiltersOpenChange(true, trigger)}
            />
            {!isDesktop && activeFiltersCount > 0 && (
              <button
                type="button"
                onClick={onReset}
                className="inline-flex min-h-11 cursor-pointer items-center px-1 text-sm font-semibold text-ink-soft underline underline-offset-4"
              >
                Effacer les filtres
              </button>
            )}
          </div>
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <SaleTypeFilter
                bar
                value={draft.saleType}
                onChange={(saleType) =>
                  setDraft((current) => ({
                    ...current,
                    saleType,
                    tribunal: !saleType || saleType === "tribunal" ? current.tribunal : "",
                  }))
                }
              />
            </div>
            {/* Écran large : au bout de la rangée des types de vente, pour que la barre de filtres
                tienne sur une ligne. */}
            {isDesktop && activeFiltersCount > 0 && (
              <button
                type="button"
                onClick={onReset}
                className="inline-flex min-h-11 shrink-0 cursor-pointer items-center px-2 text-sm font-semibold text-ink-soft underline underline-offset-4 hover:text-brand-navy"
              >
                Effacer les filtres
              </button>
            )}
          </div>
        </div>
      </div>
    </>
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
          ? scope.departments.length > 1
            ? "Départements"
            : "Département"
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
      className="relative flex min-w-0 basis-0 flex-1 items-center gap-1 rounded-md border border-field-border bg-white focus-within:outline-2 focus-within:outline-gold-soft sm:basis-auto sm:flex-1"
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
      <div className="inline-flex h-11 min-w-0 shrink-0 items-center overflow-hidden rounded-md border border-line bg-white focus-within:outline-2 focus-within:outline-gold-soft">
        <span className="flex h-full items-center border-r border-line-soft px-3 text-sm font-semibold text-brand-navy">
          Mise à prix
        </span>
        <input
          aria-label="Prix minimum"
          inputMode="numeric"
          value={draft.minPrice}
          aria-invalid={invalid}
          onChange={(event) =>
            setDraft((current) => ({ ...current, minPrice: event.target.value }))
          }
          placeholder="min €"
          className="h-full w-24 min-w-0 bg-transparent px-3 text-sm font-semibold tabular-nums outline-none"
        />
        <span aria-hidden="true" className="text-ink-soft">
          –
        </span>
        <input
          aria-label="Prix maximum"
          inputMode="numeric"
          value={draft.maxPrice}
          aria-invalid={invalid}
          onChange={(event) =>
            setDraft((current) => ({ ...current, maxPrice: event.target.value }))
          }
          placeholder="max €"
          className="h-full w-24 min-w-0 bg-transparent px-3 text-sm font-semibold tabular-nums outline-none"
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
    <label className="relative inline-flex min-h-11 shrink-0 items-center rounded-md border border-line bg-white focus-within:outline-2 focus-within:outline-gold-soft">
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
  bare = false,
}: {
  preview?: boolean;
  hasCenter?: boolean;
  /** Offre Analyse : propose aussi le tri par score d'investissement (absent ailleurs). */
  investmentScore?: boolean;
  sort: SearchSortKey;
  onChange: (sort: SearchSortKey) => void;
  /** Sans cadre ni icône (mobile : le tri est un mot dans la barre de liste). */
  bare?: boolean;
}) {
  return (
    <label
      className={`relative inline-flex min-h-11 min-w-0 items-center ${
        bare
          ? "max-w-full focus-within:outline-2 focus-within:outline-gold-soft sm:rounded-md sm:border sm:border-line sm:bg-white"
          : "max-w-full rounded-md border border-line bg-white focus-within:outline-2 focus-within:outline-gold-soft"
      }`}
    >
      <ArrowUpDown
        className={`ml-3 h-4 w-4 shrink-0 text-ink-soft ${bare ? "hidden sm:block" : ""}`}
        aria-hidden
      />
      <span className="sr-only">Tri</span>
      <select
        value={sort}
        onChange={(event) => onChange(event.target.value as SearchSortKey)}
        className={`h-full w-full min-w-0 cursor-pointer appearance-none text-ellipsis bg-transparent py-0 pr-9 text-sm font-semibold text-brand-navy outline-none ${
          bare ? "pl-1 sm:pl-2" : "pl-2"
        }`}
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
      <div className="inline-flex overflow-hidden rounded-md border border-line bg-white">
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
                  ? `bg-brand-navy text-white ${FORCED_COLORS_SELECTED}`
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

/**
 * Alertes actives d'un compte gratuit : celles de l'offre Découverte (`PLAN_LIMITS`, une seule ; la
 * base refuse la suivante, voir `20260909121656_discovery_geographic_alerts.sql`). Le repli `1` ne
 * sert qu'au typage (`null` voudrait dire « sans limite ») ; un test garde les deux d'accord.
 */
export const FREE_ALERT_LIMIT = PLAN_LIMITS.decouverte.watchedZones ?? 1;

export type FreeAlertUsage = { used: number; limit: number };

/** « 1 alerte gratuite (0/1 utilisée) » : ce que le compte gratuit permet, dit avant de créer. */
function freeAlertUsageText({ used, limit }: FreeAlertUsage): string {
  return `${limit} alerte${limit > 1 ? "s" : ""} gratuite${limit > 1 ? "s" : ""} (${Math.min(used, limit)}/${limit} utilisée${limit > 1 ? "s" : ""})`;
}

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
  freeAlertUsage = null,
  onOpen,
  label = "Créer une alerte",
  secondary = false,
  onClick,
}: {
  saving: boolean;
  /** Bouton secondaire (bordure, fond blanc) : à côté d'une action principale, comme dans l'état vide. */
  secondary?: boolean;
  /** Version mobile : l'icône et le mot « Alerte » (le nom accessible reste « Créer une alerte »). */
  compact?: boolean;
  /** Texte du bouton (hors version compacte). */
  label?: string;
  /** Connecté : on propose le choix de la fréquence ; sinon on envoie vers la connexion. */
  signedIn?: boolean;
  dailyAllowed?: boolean;
  emailRecapEnabled?: boolean;
  /** Compte gratuit : l'usage de l'alerte gratuite, rappelé dans la fenêtre de création. */
  freeAlertUsage?: FreeAlertUsage | null;
  /** Appelé à l'ouverture de la fenêtre de création (compte connecté). */
  onOpen?: () => void;
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
      className={`inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft disabled:cursor-not-allowed disabled:bg-surface-tint disabled:text-ink-soft ${
        secondary
          ? "border border-line bg-white text-brand-navy hover:border-brand-navy"
          : "bg-brand-navy text-white shadow-sm hover:bg-brand-navy-soft"
      } ${compact ? "h-11 px-3" : "min-h-11 px-4"}`}
    >
      {saving ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
      {compact ? "Alerte" : label}
    </button>
  );
  if (!signedIn) return button;
  return (
    <PopoverPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) onOpen?.();
      }}
    >
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
          {freeAlertUsage ? (
            <p className="mt-2 font-semibold text-brand-navy" data-testid="free-alert-usage">
              {freeAlertUsageText(freeAlertUsage)}
              {freeAlertUsage.used >= freeAlertUsage.limit ? (
                <span className="mt-0.5 block text-xs font-normal text-ink-soft">
                  Pour en créer une autre, modifiez ou supprimez votre alerte depuis « Mes alertes
                  ».
                </span>
              ) : null}
            </p>
          ) : null}

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
            className="mt-3 inline-flex min-h-11 w-full cursor-pointer items-center justify-center rounded-md bg-gold font-semibold text-brand-navy hover:bg-gold-light focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft"
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
  // Bouton à droite du titre du catalogue (maquette /sales validée), à côté de l'alerte. Mêmes droits
  // qu'avant : le clic d'un visiteur ou de l'offre Découverte explique, il ne télécharge rien.
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={exporting}
      title={locked ? "Export CSV réservé à l'offre Analyse" : "Exporter les résultats en CSV"}
      className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-4 text-sm font-semibold text-brand-navy transition-colors hover:border-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft disabled:cursor-not-allowed disabled:text-ink-soft"
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
      className="hidden min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-line bg-white px-3 text-sm font-semibold text-brand-navy transition-colors hover:border-brand-navy focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft 2xl:inline-flex"
    >
      <LayoutPanelLeft className="h-4 w-4" />
      {label}
    </button>
  );
}

/**
 * Compteur de la barre de liste : « 833 annonces · page 1 sur 35 ». Seul le nombre d'annonces est
 * annoncé aux lecteurs d'écran (région polie), pas toute la ligne. Le titre en phrase du catalogue
 * dit déjà la zone : elle n'est plus répétée ici.
 */
export function ResultsSummary({
  displayCount,
  isLoading,
  hasError = false,
  geocoding,
  page,
  totalPages,
  refreshing = false,
}: {
  displayCount: number;
  isLoading: boolean;
  hasError?: boolean;
  geocoding: boolean;
  page: number;
  /** Pages de la recherche ; 0 tant que le total n'est pas connu. */
  totalPages: number;
  /** La liste se met à jour (page, filtre) : un petit indicateur dans la ligne du compteur. */
  refreshing?: boolean;
}) {
  return (
    <p className="min-w-0 shrink-0 text-sm text-ink-soft sm:shrink">
      <strong className="font-semibold text-brand-navy tabular-nums" aria-live="polite">
        {isLoading
          ? "Recherche en cours…"
          : hasError
            ? "Catalogue momentanément indisponible"
            : `${displayCount.toLocaleString("fr-FR")} annonce${displayCount === 1 ? "" : "s"}`}
      </strong>
      {/* Indicateur visuel seul (l'annonce « Mise à jour des résultats » existe pour les
          lecteurs d'écran) : plus petit que la ligne, il ne change pas sa hauteur. */}
      {refreshing ? (
        <span
          aria-hidden="true"
          data-testid="results-refreshing"
          className="ml-1.5 inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent align-[-1px] motion-reduce:animate-none"
        />
      ) : null}
      {!isLoading && !hasError && totalPages > 1 ? (
        <span className="hidden tabular-nums sm:inline">
          {` · page ${page.toLocaleString("fr-FR")} sur ${totalPages.toLocaleString("fr-FR")}`}
        </span>
      ) : null}
      {geocoding ? " · localisation en cours" : ""}
    </p>
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
      <span className="flex min-h-11 min-w-0 items-center gap-2 rounded-md border border-line px-3 focus-within:outline-2 focus-within:outline-gold-soft">
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
