"use client";

import { useEffect, useState, useSyncExternalStore, type ComponentType } from "react";
import { isToastRequested, subscribeToastRequest } from "@/lib/toast";

/**
 * Affichage des notifications, à la demande : rien n'est chargé tant que personne n'a émis de
 * notification (`@/lib/toast`). À la première, `AppToaster` et sonner sont téléchargés, puis la
 * file des notifications en attente est affichée dans l'ordre.
 */
export function LazyToaster() {
  const requested = useSyncExternalStore(subscribeToastRequest, isToastRequested, () => false);
  const [Toaster, setToaster] = useState<ComponentType | null>(null);

  useEffect(() => {
    if (!requested || Toaster) return;
    let cancelled = false;
    import("@/components/AppToaster").then(
      (module) => {
        if (!cancelled) setToaster(() => module.AppToaster);
      },
      (error: unknown) => {
        // Une notification perdue ne doit pas faire tomber la page : l'action qui l'a émise a eu lieu.
        console.error("[toast] Chargement des notifications en échec", String(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [requested, Toaster]);

  return Toaster ? <Toaster /> : null;
}
