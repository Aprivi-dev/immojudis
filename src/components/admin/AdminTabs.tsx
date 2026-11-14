"use client";

import type { ReactNode } from "react";

export type AdminTab<Id extends string> = { readonly id: Id; readonly label: string };

/**
 * Barre d'onglets d'une vue admin, sur le modèle d'Emails et de Configuration : rôles ARIA, onglet
 * actif seul dans l'ordre de tabulation, flèches gauche et droite. Le panneau associé est
 * `AdminTabPanel` ; l'onglet tenu dans l'adresse, `useAdminTabParam`.
 */
export function AdminTabs<Id extends string>({
  label,
  tabs,
  active,
  onSelect,
}: {
  /** Nom accessible de la barre. */
  label: string;
  tabs: readonly AdminTab<Id>[];
  /** `null` tant que l'onglet demandé dans l'adresse n'est pas lu (`useAdminTabParam`). */
  active: Id | null;
  onSelect: (id: Id) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-2">
      {tabs.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          id={`tab-${item.id}`}
          aria-selected={active === item.id}
          aria-controls={`panel-${item.id}`}
          tabIndex={active === item.id ? 0 : -1}
          className={active === item.id ? "admin-button-primary" : "admin-button-secondary"}
          onClick={() => onSelect(item.id)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = tabs[(index + step + tabs.length) % tabs.length];
            onSelect(next.id);
            document.getElementById(`tab-${next.id}`)?.focus();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function AdminTabPanel({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
      {children}
    </div>
  );
}
