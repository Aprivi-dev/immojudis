import * as PopoverPrimitive from "@radix-ui/react-popover";
import { useId } from "react";
import type * as React from "react";
import Building2 from "lucide-react/dist/esm/icons/building-2.js";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import {
  HOME_TYPE_OPTIONS,
  NO_POINTS_TO_VERIFY_FILTER_LABEL,
  compactPrice,
} from "@/lib/search/search-filters";
import { PepiteIcon } from "@/components/PepiteBadge";
import { PEPITE_FILTER_LABEL } from "@/lib/pepite-copy";
import { DateRangeFields } from "./DateRangeFields";
import { draftPrice, priceRangeError, type SearchDraft } from "./search-page-state";

const CHIP_BASE =
  "inline-flex h-11 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border px-3 text-sm font-semibold shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold-soft";
const CHIP_IDLE = "border-line bg-white text-brand-navy hover:border-brand-navy";
const CHIP_ACTIVE = "border-brand-navy bg-brand-navy text-white";

const chipClass = (active: boolean) => `${CHIP_BASE} ${active ? CHIP_ACTIVE : CHIP_IDLE}`;

const POPOVER_CLASSES =
  "z-[70] w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-white p-4 text-sm text-foreground shadow-xl outline-none";

/**
 * Les trois critères les plus utilisés, sous le champ de recherche, sur mobile : « Type de bien »,
 * « Mise à prix max. » et « Date de vente ». Avant, ils ne se trouvaient que dans « Filtres
 * avancés » sous `lg`. La rangée défile horizontalement ; chaque pastille mesure 44 px de haut.
 * Les fenêtres des pastilles sont rendues hors de la rangée (portail) : le défilement ne les rogne pas.
 *
 * Avec un compte (`preview` faux), deux pastilles à bascule s'y ajoutent : « Sous la fourchette » et
 * « Sans point à vérifier ». Leur texte complet (ce qu'elles couvrent, ce qu'elles ne couvrent pas) est
 * dans « Filtres avancés » ; ici, le nom court seulement, et `aria-pressed` dit l'état.
 */
export function MobileFilterChips({
  draft,
  setDraft,
  preview = false,
  pepitesActive = false,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  /** Visiteur sans compte : les deux filtres de repères nécessitent un compte, ils ne sont pas proposés. */
  preview?: boolean;
  /**
   * Les pépites sont ouvertes au public (liste non vide) : la pastille « Pépites seulement » est proposée en
   * première, aux visiteurs aussi. Sinon (mode « shadow », panne) elle n'apparaît pas : pas de filtre qui ne
   * renverrait jamais rien.
   */
  pepitesActive?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="Filtres rapides"
      className="-mx-4 flex w-full gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none] lg:hidden"
    >
      {pepitesActive ? (
        <button
          type="button"
          aria-pressed={draft.pepite}
          onClick={() => setDraft((current) => ({ ...current, pepite: !current.pepite }))}
          className={chipClass(draft.pepite)}
        >
          {draft.pepite ? <Check className="size-4" aria-hidden /> : <PepiteIcon />}
          {PEPITE_FILTER_LABEL}
        </button>
      ) : null}
      <HomeTypeChip draft={draft} setDraft={setDraft} />
      <MaxPriceChip draft={draft} setDraft={setDraft} />
      <SaleDateChip draft={draft} setDraft={setDraft} />
      {preview ? null : (
        <>
          <ToggleChip
            pressed={draft.belowRange}
            label="Mise à prix sous le marché"
            title="Mise à prix sous la fourchette des ventes comparables"
            onToggle={() =>
              setDraft((current) => ({ ...current, belowRange: !current.belowRange }))
            }
          />
          <ToggleChip
            pressed={draft.noPointsToVerify}
            label={NO_POINTS_TO_VERIFY_FILTER_LABEL}
            onToggle={() =>
              setDraft((current) => ({ ...current, noPointsToVerify: !current.noPointsToVerify }))
            }
          />
        </>
      )}
    </div>
  );
}

function ToggleChip({
  pressed,
  label,
  title,
  onToggle,
}: {
  pressed: boolean;
  label: string;
  /** Nom complet quand le libellé court ne suffit pas à un lecteur d'écran. */
  title?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={title}
      onClick={onToggle}
      className={chipClass(pressed)}
    >
      {label}
    </button>
  );
}

function HomeTypeChip({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  const active = draft.homeTypes.length > 0;
  return (
    <label
      className={`${chipClass(active)} relative pr-9 focus-within:outline-2 focus-within:outline-gold-soft`}
    >
      <Building2 className="h-4 w-4" aria-hidden />
      <select
        aria-label="Type de bien"
        value={draft.homeTypes[0] ?? "all"}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            homeTypes: event.target.value === "all" ? [] : [event.target.value],
          }))
        }
        className="cursor-pointer appearance-none bg-transparent text-sm font-semibold outline-none"
      >
        <option value="all">Type de bien</option>
        {HOME_TYPE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 h-4 w-4" aria-hidden />
    </label>
  );
}

function MaxPriceChip({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  const max = draftPrice(draft.maxPrice);
  const rangeError = priceRangeError(draft);
  const errorId = useId();
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={chipClass(max != null)}>
          Mise à prix max.
          {max != null ? ` · ${compactPrice(max)}` : null}
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={8}
          aria-label="Mise à prix maximum"
          className={POPOVER_CLASSES}
        >
          <label className="grid gap-1.5">
            <span className="font-semibold text-brand-navy">Mise à prix maximum (€)</span>
            <input
              inputMode="numeric"
              value={draft.maxPrice}
              aria-invalid={rangeError ? true : undefined}
              aria-describedby={rangeError ? errorId : undefined}
              onChange={(event) =>
                setDraft((current) => ({ ...current, maxPrice: event.target.value }))
              }
              placeholder="Aucun"
              className="form-input h-11"
            />
          </label>
          {rangeError ? (
            <p id={errorId} role="alert" className="mt-2 text-sm font-semibold text-danger">
              {rangeError}
            </p>
          ) : null}
          <button
            type="button"
            onClick={() => setDraft((current) => ({ ...current, maxPrice: "" }))}
            className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold underline underline-offset-4"
          >
            Effacer le maximum
          </button>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

function SaleDateChip({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  const active = Boolean(draft.minSaleDate || draft.maxSaleDate);
  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger asChild>
        <button type="button" className={chipClass(active)}>
          <CalendarDays className="h-4 w-4" aria-hidden />
          Date de vente
          {active ? (
            <>
              {/* Le « 1 » compte les filtres de date actifs : dit en mot pour un lecteur d'écran. */}
              <span aria-hidden> · 1</span>
              <span className="sr-only">, 1 filtre actif</span>
            </>
          ) : null}
          <ChevronDown className="h-4 w-4" aria-hidden />
        </button>
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          align="start"
          sideOffset={8}
          aria-label="Date de vente"
          className={POPOVER_CLASSES}
        >
          <DateRangeFields draft={draft} setDraft={setDraft} />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
