import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { MapPreview } from "./MapPreview";

/** Identifiant du cadre de la carte : cible du lien d'évitement « Aller à la carte ». */
export const DESKTOP_MAP_ZONE_ID = "sales-map";

/**
 * Cadre de la carte du bureau : l'aperçu (`MapPreview`) tant que la carte n'est pas demandée, puis
 * la carte (`children`).
 *
 * Quand la carte est demandée par le bouton « Afficher la carte » (clic, Entrée ou Espace), le
 * bouton disparaît avec l'aperçu : sans autre précaution le focus retomberait sur `<body>` et un
 * lecteur d'écran ne dirait rien. Le cadre (`tabIndex={-1}`, hors de l'ordre de tabulation) reçoit
 * donc le focus dès que la carte prend la place de l'aperçu, et la région `aria-live` (présente
 * dès le début, vide, pour que l'annonce soit lue) dit « Carte affichée ». Les autres démarrages
 * (appui, molette, survol) ne déplacent pas le focus : la personne est ailleurs, avec sa souris.
 */
export function DesktopMapZone({
  started,
  onStart,
  children,
}: {
  started: boolean;
  onStart: () => void;
  children: ReactNode;
}) {
  const zone = useRef<HTMLDivElement>(null);
  const focusOnStart = useRef(false);
  const [announcement, setAnnouncement] = useState("");

  const startFromButton = useCallback(() => {
    focusOnStart.current = true;
    onStart();
  }, [onStart]);

  useEffect(() => {
    if (!started || !focusOnStart.current) return;
    focusOnStart.current = false;
    zone.current?.focus();
    setAnnouncement("Carte affichée");
  }, [started]);

  return (
    <div
      ref={zone}
      id={DESKTOP_MAP_ZONE_ID}
      tabIndex={-1}
      role="region"
      aria-label="Carte des ventes"
      className="sticky top-[var(--sales-header-height)] h-[calc(100svh_-_var(--sales-header-height))] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-gold-soft"
    >
      {started ? children : <MapPreview onStart={onStart} onExplicitStart={startFromButton} />}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
