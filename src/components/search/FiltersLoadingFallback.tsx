"use client";

import { FocusScope } from "@radix-ui/react-focus-scope";
import { useRef } from "react";

export function FiltersLoadingFallback() {
  const dialogRef = useRef<HTMLDivElement>(null);

  return (
    <FocusScope
      asChild
      loop
      trapped
      onMountAutoFocus={(event) => {
        event.preventDefault();
        dialogRef.current?.focus();
      }}
      onUnmountAutoFocus={(event) => {
        // The loaded Radix dialog owns focus restoration once its chunk mounts.
        event.preventDefault();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="filters-loading-title"
        tabIndex={-1}
        className="fixed inset-0 z-50 bg-[#132238]/55 backdrop-blur-sm outline-none"
      >
        <div className="absolute inset-y-0 right-0 grid w-full max-w-3xl place-items-center bg-white px-6 shadow-xl">
          <h2 id="filters-loading-title" className="sr-only">
            Filtres avancés
          </h2>
          <p
            role="status"
            aria-live="polite"
            aria-label="Chargement des filtres avancés…"
            className="text-sm font-bold text-[#132238]"
          >
            Chargement des filtres avancés…
          </p>
        </div>
      </div>
    </FocusScope>
  );
}
