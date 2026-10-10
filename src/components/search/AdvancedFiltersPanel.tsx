"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import type * as React from "react";
import { useRef } from "react";
import Landmark from "lucide-react/dist/esm/icons/landmark.js";
import MapPin from "lucide-react/dist/esm/icons/map-pin.js";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw.js";
import X from "lucide-react/dist/esm/icons/x.js";
import { Input } from "@/components/ui/input";
import { DPE_CLASSES, dpeColor, type DpeClass } from "@/lib/dpe";
import { HOME_TYPE_OPTIONS, STATUS_OPTIONS } from "@/lib/search/search-filters";
import { type SearchDraft, toggleValue } from "./search-page-state";
import { SaleTypeFilter } from "./SaleTypeFilter";
import { DateRangeFields } from "./DateRangeFields";
import { BedsBathsFilter, InlineTextFilter, PriceFilter } from "./SearchHeader";

export function MoreFiltersModal({
  open,
  analysisLocked = false,
  preview = false,
  draft,
  setDraft,
  activeFiltersCount,
  onClose,
  onReset,
}: {
  open: boolean;
  analysisLocked?: boolean;
  preview?: boolean;
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  onClose: () => void;
  onReset: () => void;
}) {
  const triggerRef = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-brand-navy/55 backdrop-blur-sm" />
        <DialogPrimitive.Content
          onOpenAutoFocus={() => {
            triggerRef.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            triggerRef.current?.focus();
          }}
          aria-describedby={undefined}
          className="fixed inset-y-0 right-0 z-50 w-full max-w-3xl bg-white shadow-xl outline-none"
        >
          <DialogPrimitive.Title className="sr-only">Filtres avancés</DialogPrimitive.Title>
          <MobileFilterDrawer
            analysisLocked={analysisLocked}
            preview={preview}
            draft={draft}
            setDraft={setDraft}
            activeFiltersCount={activeFiltersCount}
            onClose={onClose}
            onReset={onReset}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
export function MobileFilterDrawer({
  analysisLocked = false,
  preview = false,
  draft,
  setDraft,
  activeFiltersCount,
  onClose,
  onReset,
}: {
  analysisLocked?: boolean;
  preview?: boolean;
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
  activeFiltersCount: number;
  onClose: () => void;
  onReset: () => void;
}) {
  return (
    <aside className="relative ml-auto flex h-full w-full max-w-3xl flex-col overflow-hidden bg-white shadow-2xl sm:rounded-md">
      <div className="flex h-16 shrink-0 items-center justify-between border-b border-brand-navy/10 px-4">
        <div>
          <h2 id="more-filters-title" className="text-base font-extrabold text-brand-navy">
            Filtres avancés
          </h2>
          <p className="text-xs font-semibold text-ink-soft">
            {activeFiltersCount.toLocaleString("fr-FR")} filtre{activeFiltersCount === 1 ? "" : "s"}{" "}
            actif{activeFiltersCount === 1 ? "" : "s"}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="grid h-10 w-10 cursor-pointer place-items-center rounded-md border border-line-soft bg-white transition-colors hover:bg-surface-muted"
          aria-label="Fermer"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5">
        <div className="mb-5">
          <SaleTypeFilter
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
        <div className="mb-5 grid gap-4 sm:grid-cols-2">
          <fieldset className="min-w-0">
            <legend className="mb-2 text-sm font-extrabold text-brand-navy">Mise à prix</legend>
            <PriceFilter stacked draft={draft} setDraft={setDraft} />
          </fieldset>
          <fieldset className="min-w-0">
            <legend className="mb-2 text-sm font-extrabold text-brand-navy">
              Chambres et salles de bain
            </legend>
            <BedsBathsFilter stacked draft={draft} setDraft={setDraft} />
          </fieldset>
          <InlineTextFilter
            label="Ville"
            icon={MapPin}
            value={draft.city}
            placeholder="Ex. Bordeaux"
            onChange={(city) => setDraft((c) => ({ ...c, city }))}
          />
          {(!draft.saleType || draft.saleType === "tribunal") && (
            <InlineTextFilter
              label="Tribunal"
              icon={Landmark}
              value={draft.tribunal}
              placeholder="Ex. TJ Bordeaux"
              onChange={(tribunal) => setDraft((c) => ({ ...c, tribunal }))}
            />
          )}
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <AdvancedGroup title="Localisation">
            <FilterField label="Département">
              <Input
                value={draft.department}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, department: event.target.value }))
                }
                placeholder="33 ou Gironde"
                className="h-10 bg-white"
              />
            </FilterField>
            <fieldset disabled={preview} className="space-y-3 disabled:opacity-60">
              {preview && <p className="text-xs">La recherche par rayon nécessite un compte.</p>}
              <FilterField label="Autour de">
                <Input
                  value={draft.aroundAddress}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      aroundAddress: event.target.value,
                      aroundRadius:
                        event.target.value && !current.aroundRadius ? "15" : current.aroundRadius,
                    }))
                  }
                  placeholder="Adresse, ville ou tribunal"
                  className="h-10 bg-white"
                />
              </FilterField>
              <FilterField label="Rayon km">
                <Input
                  inputMode="numeric"
                  value={draft.aroundRadius}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, aroundRadius: event.target.value }))
                  }
                  placeholder="15"
                  className="h-10 bg-white"
                />
              </FilterField>
            </fieldset>
          </AdvancedGroup>

          <AdvancedGroup title="Prix et surface">
            <DateRangeFields draft={draft} setDraft={setDraft} />
            <FilterField label="Surface minimum">
              <Input
                inputMode="numeric"
                value={draft.minSqft}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, minSqft: event.target.value }))
                }
                placeholder="60"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label="Surface maximum">
              <Input
                inputMode="numeric"
                value={draft.maxSqft}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxSqft: event.target.value }))
                }
                placeholder="180"
                className="h-10 bg-white"
              />
            </FilterField>
            <FilterField label={preview ? "Prix/m² max · avec un compte" : "Prix/m² max"}>
              <Input
                inputMode="numeric"
                disabled={preview}
                value={draft.maxPricePerM2}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, maxPricePerM2: event.target.value }))
                }
                placeholder="3500"
                className="h-10 bg-white"
              />
            </FilterField>
          </AdvancedGroup>

          <fieldset disabled={analysisLocked} className="disabled:opacity-60">
            <AdvancedGroup title="Statut et analyse">
              {analysisLocked && (
                <p className="text-sm">Ces critères nécessitent l’offre Analyse.</p>
              )}
              <FilterField label="Occupation">
                <select
                  value={draft.occupancy || "all"}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      occupancy: event.target.value === "all" ? "" : event.target.value,
                    }))
                  }
                  className="form-input h-10 w-full cursor-pointer bg-white text-sm"
                >
                  <option value="all">Toutes</option>
                  <option value="free">Libre</option>
                  <option value="occupied">Occupé</option>
                  <option value="rented">Loué</option>
                </select>
              </FilterField>
              <FilterField label="Score min">
                <Input
                  inputMode="numeric"
                  value={draft.minScore}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, minScore: event.target.value }))
                  }
                  placeholder="70"
                  className="h-10 bg-white"
                />
              </FilterField>
              <FilterField label="Rendement min">
                <Input
                  inputMode="numeric"
                  value={draft.minYield}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, minYield: event.target.value }))
                  }
                  placeholder="5"
                  className="h-10 bg-white"
                />
              </FilterField>

              <label className="flex cursor-pointer items-center gap-3 rounded-md border border-line-soft bg-surface-muted px-3 py-2 text-sm font-bold text-brand-navy">
                <input
                  type="checkbox"
                  checked={draft.houseWithLand}
                  onChange={(event) =>
                    setDraft((current) => ({ ...current, houseWithLand: event.target.checked }))
                  }
                  className="h-4 w-4 accent-brand-navy"
                />
                Maison avec terrain
              </label>
              <div>
                <span className="mb-2 block text-sm font-semibold text-brand-navy">
                  Classe énergétique (DPE)
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {DPE_CLASSES.map((dpeClass) => (
                    <DpeChipToggle
                      key={dpeClass}
                      dpeClass={dpeClass}
                      active={draft.dpeClasses.includes(dpeClass)}
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          dpeClasses: toggleValue(current.dpeClasses, dpeClass),
                        }))
                      }
                    />
                  ))}
                </div>
              </div>
            </AdvancedGroup>
          </fieldset>

          <AdvancedGroup title="Mots-clés et statut">
            <FilterField label="Mots-clés">
              <Input
                value={draft.keywords}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, keywords: event.target.value }))
                }
                placeholder="jardin, garage, occupé..."
                className="h-10 bg-white"
              />
            </FilterField>

            <label className="flex cursor-pointer items-center gap-3 rounded-md border border-line-soft bg-surface-muted px-3 py-2 text-sm font-bold text-brand-navy">
              <input
                type="checkbox"
                disabled={analysisLocked}
                checked={draft.openHouse}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, openHouse: event.target.checked }))
                }
                className="h-4 w-4 accent-brand-navy"
              />
              Visite renseignée
              {analysisLocked && <span className="text-xs">· offre Analyse</span>}
            </label>
          </AdvancedGroup>
        </div>

        <AdvancedGroup title="Types de biens" className="mt-5">
          <div className="flex flex-wrap gap-2">
            {HOME_TYPE_OPTIONS.map((option) => (
              <ChipToggle
                key={option.value}
                active={draft.homeTypes.includes(option.value)}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    homeTypes: toggleValue(current.homeTypes, option.value),
                  }))
                }
              >
                {option.label}
              </ChipToggle>
            ))}
          </div>
        </AdvancedGroup>

        <AdvancedGroup title="Statuts" className="mt-5">
          <div className="flex flex-wrap gap-2">
            {STATUS_OPTIONS.map((option) => (
              <ChipToggle
                key={option.value}
                active={draft.status.includes(option.value)}
                onClick={() =>
                  setDraft((current) => ({
                    ...current,
                    status: toggleValue(current.status, option.value),
                  }))
                }
              >
                {option.label}
              </ChipToggle>
            ))}
          </div>
        </AdvancedGroup>
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-brand-navy/10 p-4 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onReset}
          className="inline-flex h-10 cursor-pointer items-center justify-center gap-2 rounded-md border border-sand bg-surface px-4 text-sm font-bold text-gold-text transition-colors hover:border-gold"
        >
          <RotateCcw className="h-4 w-4" />
          Réinitialiser
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-10 cursor-pointer items-center justify-center rounded-md bg-brand-navy px-4 text-sm font-bold text-white transition-colors hover:bg-brand-navy-soft"
        >
          Afficher les résultats
        </button>
      </div>
    </aside>
  );
}

export function AdvancedGroup({
  title,
  className,
  children,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <h3 className="mb-3 text-sm font-extrabold text-brand-navy">{title}</h3>
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

export function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="space-y-1">
      <span className="block text-sm font-semibold text-brand-navy">{label}</span>
      {children}
    </label>
  );
}

export function ChipToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
        active
          ? "border-brand-navy bg-brand-navy text-white"
          : "border-line-soft bg-white text-brand-navy hover:border-brand-navy"
      }`}
    >
      {children}
    </button>
  );
}

export function DpeChipToggle({
  active,
  dpeClass,
  onClick,
}: {
  active: boolean;
  dpeClass: DpeClass;
  onClick: () => void;
}) {
  const color = dpeColor(dpeClass);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex h-9 min-w-9 cursor-pointer items-center justify-center rounded-md border px-2 text-sm font-extrabold transition-transform hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
      style={{
        backgroundColor: active ? color?.background : "#ffffff",
        borderColor: color?.border,
        color: active ? color?.foreground : "var(--brand-navy)",
      }}
    >
      {dpeClass}
    </button>
  );
}
