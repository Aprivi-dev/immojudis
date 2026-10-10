"use client";

import { useEffect, useState } from "react";
import { Toaster } from "sonner";

/**
 * Sur téléphone, les notifications s'affichent en bas et au centre, au-dessus de
 * la barre « Filtres / Carte » du catalogue ; à partir de 640 px, en haut à droite.
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

  return (
    <Toaster
      richColors
      position={compact ? "bottom-center" : "top-right"}
      offset={compact ? { bottom: "5rem", left: "1rem", right: "1rem" } : undefined}
      mobileOffset={{ bottom: "5rem", left: "1rem", right: "1rem" }}
    />
  );
}
