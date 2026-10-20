"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType } from "react";
import { isToastRequested, subscribeToastAnnouncements, subscribeToastRequest } from "@/lib/toast";

/**
 * Affichage des notifications, à la demande : rien n'est chargé tant que personne n'a émis de
 * notification (`@/lib/toast`). À la première, `AppToaster` et sonner sont téléchargés, puis la
 * file des notifications en attente est affichée dans l'ordre.
 *
 * Une région vivante vide (`role="status"`, `aria-live="polite"`) est montée dès le premier rendu :
 * elle relaie le texte des notifications qui arrivent avant que sonner soit prêt (sa propre région
 * naît avec la première notification, et un lecteur d'écran n'annonce pas ce qui apparaît avec la
 * région). Ensuite sonner annonce lui-même ; la région ne répète rien.
 */
export function LazyToaster() {
  const requested = useSyncExternalStore(subscribeToastRequest, isToastRequested, () => false);
  const [Toaster, setToaster] = useState<ComponentType | null>(null);
  const [announcement, setAnnouncement] = useState("");
  // Un texte identique deux fois de suite doit se relire : un espace insécable alterné le change.
  const repeat = useRef(false);
  useEffect(
    () =>
      subscribeToastAnnouncements((text) => {
        repeat.current = !repeat.current;
        setAnnouncement(repeat.current ? text : `${text}\u00a0`);
      }),
    [],
  );

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

  return (
    <>
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="toast-announcer"
      >
        {announcement}
      </div>
      {Toaster ? <Toaster /> : null}
    </>
  );
}
