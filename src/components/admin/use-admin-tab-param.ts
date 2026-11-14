"use client";

import { useEffect, useState } from "react";
import type { AdminTab } from "@/components/admin/AdminTabs";

/**
 * Onglet tenu dans l'adresse (`?onglet=…`), comme Emails et l'Agent IA : lu au montage, écrit sans
 * navigation (`useSearchParams` sortirait la page du HTML préfabriqué, voir `AuthGate`). Vaut `null`
 * avant la lecture : aucun onglet n'est encore monté, l'onglet par défaut ne charge donc rien quand
 * l'adresse en demande un autre (anciennes adresses redirigées vers un onglet).
 *
 * Module à part de `AdminTabs` : Turbopack ne retire pas un export inutilisé, et la vue Avocats, qui
 * n'en a pas besoin, est à quelques centaines d'octets de son budget de JavaScript.
 */
export function useAdminTabParam<Id extends string>(
  tabs: readonly AdminTab<Id>[],
  fallback: Id,
): [Id | null, (id: Id) => void] {
  const [tab, setTab] = useState<Id | null>(null);

  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get("onglet");
    setTab(tabs.find((item) => item.id === requested)?.id ?? fallback);
  }, [tabs, fallback]);

  function select(id: Id) {
    setTab(id);
    const url = new URL(window.location.href);
    url.searchParams.set("onglet", id);
    window.history.replaceState(window.history.state, "", url);
  }

  return [tab, select];
}
