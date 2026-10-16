"use client";

import { lazy, Suspense, useEffect, useState } from "react";
import { whenIdle } from "@/lib/when-idle";

const Toaster = lazy(() => import("sonner").then((module) => ({ default: module.Toaster })));

/**
 * Sur téléphone, les notifications s'affichent en bas et au centre, au-dessus de
 * la barre « Filtres / Carte » du catalogue ; à partir de 640 px, en haut à droite.
 *
 * Sonner n'est pas dans le JavaScript commun : il se charge quand le navigateur est inactif.
 * Une notification émise avant que le `Toaster` soit monté n'est pas perdue : Sonner rejoue les
 * notifications actives à l'abonnement du `Toaster`.
 */
export function AppToaster() {
  const [compact, setCompact] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 639px)");
    setCompact(media.matches);
    const update = () => setCompact(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => whenIdle(() => setReady(true)), []);

  if (!ready) return null;
  return (
    <Suspense fallback={null}>
      <Toaster
        richColors
        position={compact ? "bottom-center" : "top-right"}
        offset={compact ? { bottom: "5rem", left: "1rem", right: "1rem" } : undefined}
        mobileOffset={{ bottom: "5rem", left: "1rem", right: "1rem" }}
      />
    </Suspense>
  );
}
