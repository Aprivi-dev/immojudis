"use client";

import CalendarDays from "lucide-react/dist/esm/icons/calendar-days.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import type * as React from "react";
import { useEffect, useId, useRef, useState } from "react";
import type { SearchDraft } from "./search-page-state";
import { DateRangeFields } from "./DateRangeFields";

export function DateFilter({
  draft,
  setDraft,
}: {
  draft: SearchDraft;
  setDraft: React.Dispatch<React.SetStateAction<SearchDraft>>;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const contentId = useId();

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      contentRef.current?.querySelector<HTMLInputElement>("input")?.focus();
      return;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen((current) => !current)}
        className="inline-flex h-10 items-center gap-2 rounded-md border border-line px-3 text-sm font-medium"
      >
        <CalendarDays className="h-4 w-4" />
        Date de vente{draft.minSaleDate || draft.maxSaleDate ? " · 1" : ""}
        <ChevronDown className="h-4 w-4" />
      </button>
      {open ? (
        <div
          ref={contentRef}
          id={contentId}
          role="dialog"
          aria-label="Date de vente"
          className="absolute right-0 top-full z-50 mt-2 w-64 rounded-md border bg-white p-4 shadow-lg"
        >
          <DateRangeFields draft={draft} setDraft={setDraft} />
        </div>
      ) : null}
    </div>
  );
}
