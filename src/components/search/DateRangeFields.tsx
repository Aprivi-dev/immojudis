"use client";

import type * as React from "react";
import type { SearchDraft } from "./search-page-state";

export function DateRangeFields({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  return (
    <div className="grid gap-3">
      <label className="grid gap-1 text-sm">
        À partir du
        <input
          type="date"
          aria-label="Date de vente minimum"
          value={draft.minSaleDate}
          max={draft.maxSaleDate || undefined}
          onChange={(e) =>
            setDraft((c) => ({
              ...c,
              minSaleDate: e.target.value,
              maxSaleDate: c.maxSaleDate && e.target.value > c.maxSaleDate ? "" : c.maxSaleDate,
            }))
          }
          className="h-11 min-w-0 rounded border px-2"
        />
      </label>
      <label className="grid gap-1 text-sm">
        Jusqu’au
        <input
          type="date"
          aria-label="Date de vente maximum"
          value={draft.maxSaleDate}
          min={draft.minSaleDate || undefined}
          onChange={(e) =>
            setDraft((c) => ({
              ...c,
              maxSaleDate: e.target.value,
              minSaleDate: c.minSaleDate && e.target.value < c.minSaleDate ? "" : c.minSaleDate,
            }))
          }
          className="h-11 min-w-0 rounded border px-2"
        />
      </label>
      <button
        type="button"
        className="min-h-9 text-sm underline"
        onClick={() => setDraft((c) => ({ ...c, minSaleDate: "", maxSaleDate: "" }))}
      >
        Effacer les dates
      </button>
    </div>
  );
}
