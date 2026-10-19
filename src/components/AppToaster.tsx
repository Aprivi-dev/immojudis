"use client";

import { useEffect, useState } from "react";
import { Toaster, toast } from "sonner";
import { registerToaster } from "@/lib/toast";

/**
 * Sur téléphone, les notifications s'affichent en bas et au centre, au-dessus de
 * la barre « Filtres / Carte » du catalogue ; à partir de 640 px, en haut à droite.
 *
 * Ce composant (et sonner avec lui) n'est chargé qu'à la première notification, par
 * `LazyToaster`. Une fois affiché, il s'enregistre auprès de `@/lib/toast`, qui lui remet les
 * notifications arrivées pendant le chargement.
 */
export function AppToaster() {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    setCompact(media.matches);
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  // L'effet du composant parent passe après celui de `Toaster` : l'abonnement de sonner existe
  // quand la file est vidée.
  useEffect(() => {
    registerToaster(toast);
    return () => registerToaster(null);
  }, []);

  return (
    <Toaster
      richColors
      position={compact ? "bottom-center" : "top-right"}
      offset={compact ? { bottom: "5rem", left: "1rem", right: "1rem" } : undefined}
      mobileOffset={{ bottom: "5rem", left: "1rem", right: "1rem" }}
    />
  );
}
