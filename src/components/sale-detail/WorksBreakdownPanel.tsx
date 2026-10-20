"use client";

import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import Plus from "lucide-react/dist/esm/icons/plus.js";
import Trash2 from "lucide-react/dist/esm/icons/trash-2.js";
import { useEffect, useId, useRef, useState } from "react";
import { formatPrice } from "@/lib/format";
import {
  emptyWorksBreakdownItem,
  MAX_WORKS_BREAKDOWN_ITEMS,
  parseWorksNumber,
  summarizeWorksBreakdown,
  WORKS_BREAKDOWN_KINDS,
  WORKS_BREAKDOWN_LIMITS,
  worksBreakdownKindLabel,
  worksBreakdownLineTotal,
  type WorksBreakdownItem,
} from "@/lib/works-breakdown";

type EditableField = "kind" | "label" | "quantity" | "unit" | "unitCost";

const INPUT_CLASS =
  "min-h-11 w-full rounded-lg border border-border bg-white px-3 text-sm tabular-nums focus-visible:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/30";

/**
 * « Détail de vos travaux » (point 74) : panneau facultatif où l'utilisateur chiffre lui-même ses
 * postes. Aucun prix, aucune valeur par défaut, aucun montant suggéré : il saisit quantité, unité et
 * coût unitaire, et le total (renvoyé par `onChange`) alimente le budget travaux du calcul. Les
 * montants sont les siens, sans valeur de devis ; aucune notion fiscale.
 */
export function WorksBreakdownPanel({
  items,
  onChange,
}: {
  items: readonly WorksBreakdownItem[];
  onChange: (items: WorksBreakdownItem[]) => void;
}) {
  const componentId = useId();
  const panelId = `${componentId}-panel`;
  const titleId = `${componentId}-title`;
  const [open, setOpen] = useState(items.length > 0);
  const nextId = useRef(0);
  const addButton = useRef<HTMLButtonElement>(null);
  // Poste qui vient d'être ajouté : son champ « Poste » prend le focus.
  const [focusId, setFocusId] = useState<string | null>(null);
  const summary = summarizeWorksBreakdown(items);
  const atLimit = items.length >= MAX_WORKS_BREAKDOWN_ITEMS;

  const addItem = () => {
    if (atLimit) return;
    nextId.current += 1;
    const id = `poste-${Date.now().toString(36)}-${nextId.current}`;
    setFocusId(id);
    onChange([...items, emptyWorksBreakdownItem(id)]);
  };

  const updateItem = (id: string, field: EditableField, value: string) =>
    onChange(items.map((item) => (item.id === id ? { ...item, [field]: value } : item)));

  const removeItem = (id: string) => {
    onChange(items.filter((item) => item.id !== id));
    addButton.current?.focus();
  };

  return (
    <div className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-semibold text-brand-navy transition-colors hover:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
      >
        Détailler les travaux
        <ChevronDown
          className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open ? (
        <div
          id={panelId}
          role="group"
          aria-labelledby={titleId}
          className="mt-3 grid gap-4 rounded-lg border border-border bg-muted/30 p-3 sm:p-5"
        >
          <div>
            <h3 id={titleId} className="text-lg font-semibold text-brand-navy">
              Détail de vos travaux
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Montants saisis par vous, sans valeur de devis. Immojudis ne propose aucun prix :
              chaque quantité et chaque coût viennent de vous. Le total est reporté dans votre
              budget travaux.
            </p>
          </div>

          {items.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Aucun poste pour l’instant. Ajoutez les postes de travaux que vous envisagez.
            </p>
          ) : (
            <ul className="grid gap-3" aria-label="Postes de vos travaux">
              {items.map((item, index) => (
                <WorksBreakdownRow
                  key={item.id}
                  item={item}
                  position={index + 1}
                  autoFocus={focusId === item.id}
                  onFocused={() => setFocusId(null)}
                  onChange={(field, value) => updateItem(item.id, field, value)}
                  onRemove={() => removeItem(item.id)}
                />
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button
              ref={addButton}
              type="button"
              onClick={addItem}
              disabled={atLimit}
              className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-white px-4 text-sm font-semibold text-brand-navy transition-colors hover:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="h-4 w-4" aria-hidden />
              Ajouter un poste
            </button>
            {atLimit ? (
              <span className="text-xs text-muted-foreground">
                {MAX_WORKS_BREAKDOWN_ITEMS} postes au maximum.
              </span>
            ) : null}
          </div>

          <div className="flex flex-col gap-1 border-t border-border pt-3 sm:flex-row sm:items-baseline sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-brand-navy">Total de vos postes</p>
              {summary.incomplete > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {summary.incomplete} poste{summary.incomplete > 1 ? "s" : ""} à compléter (poste,
                  quantité et coût) : {summary.incomplete > 1 ? "ils ne comptent" : "il ne compte"}{" "}
                  pas dans le total.
                </p>
              ) : null}
            </div>
            <p
              role="status"
              aria-label="Total de vos postes"
              className="text-xl font-semibold tabular-nums text-brand-navy"
            >
              {summary.complete > 0 ? formatPrice(summary.total) : "—"}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WorksBreakdownRow({
  item,
  position,
  autoFocus,
  onFocused,
  onChange,
  onRemove,
}: {
  item: WorksBreakdownItem;
  position: number;
  autoFocus: boolean;
  onFocused: () => void;
  onChange: (field: EditableField, value: string) => void;
  onRemove: () => void;
}) {
  const name = `poste ${position}${item.kind ? ` (${worksBreakdownKindLabel(item.kind)})` : ""}`;
  const total = worksBreakdownLineTotal(item);
  const invalid = (value: string) => value.trim() !== "" && parseWorksNumber(value) == null;
  const selectRef = useRef<HTMLSelectElement>(null);

  useEffect(() => {
    if (!autoFocus) return;
    selectRef.current?.focus();
    onFocused();
  }, [autoFocus, onFocused]);

  return (
    <li className="grid gap-3 rounded-lg border border-border bg-white p-3">
      <div className="flex items-end gap-2">
        <label className="grid min-w-0 flex-1 gap-1 text-sm">
          <span className="font-medium text-foreground">Poste {position}</span>
          <select
            ref={selectRef}
            value={item.kind}
            onChange={(event) => onChange("kind", event.target.value)}
            aria-label={`Type, ${name}`}
            className={INPUT_CLASS}
          >
            <option value="" disabled>
              Choisir un poste
            </option>
            {WORKS_BREAKDOWN_KINDS.map((kind) => (
              <option key={kind.key} value={kind.key}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Retirer le ${name} du détail`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border text-brand-navy transition-colors hover:border-gold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
        </button>
      </div>

      {item.kind === "autre" ? (
        <label className="grid gap-1 text-sm">
          <span className="font-medium text-foreground">Précision (facultatif)</span>
          <input
            value={item.label}
            maxLength={WORKS_BREAKDOWN_LIMITS.label}
            onChange={(event) => onChange("label", event.target.value)}
            aria-label={`Précision, ${name}`}
            className={INPUT_CLASS}
          />
        </label>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <label className="grid content-start gap-1 text-sm">
          <span className="font-medium text-foreground">Quantité</span>
          <input
            type="text"
            inputMode="decimal"
            value={item.quantity}
            maxLength={WORKS_BREAKDOWN_LIMITS.number}
            onChange={(event) => onChange("quantity", event.target.value)}
            aria-label={`Quantité, ${name}`}
            aria-invalid={invalid(item.quantity)}
            className={INPUT_CLASS}
          />
        </label>
        <label className="grid content-start gap-1 text-sm">
          <span className="font-medium text-foreground">Unité</span>
          <input
            value={item.unit}
            maxLength={WORKS_BREAKDOWN_LIMITS.unit}
            onChange={(event) => onChange("unit", event.target.value)}
            aria-label={`Unité, ${name}`}
            className={INPUT_CLASS}
          />
        </label>
        <label className="grid content-start gap-1 text-sm">
          <span className="font-medium text-foreground">Coût unitaire (€)</span>
          <input
            type="text"
            inputMode="decimal"
            value={item.unitCost}
            maxLength={WORKS_BREAKDOWN_LIMITS.number}
            onChange={(event) => onChange("unitCost", event.target.value)}
            aria-label={`Coût unitaire, ${name}`}
            aria-invalid={invalid(item.unitCost)}
            className={INPUT_CLASS}
          />
        </label>
        <div className="grid content-start gap-1 text-sm">
          <span className="font-medium text-foreground">Total du poste</span>
          <output
            aria-label={`Total, ${name}`}
            className="flex min-h-11 items-center font-semibold tabular-nums text-brand-navy"
          >
            {total != null ? formatPrice(total) : "À compléter"}
          </output>
        </div>
      </div>
    </li>
  );
}
