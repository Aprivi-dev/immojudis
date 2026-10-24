"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import styles from "./HomeProductTour.module.css";

type Item = { id: string; tab: ReactNode; panel: ReactNode };

const MOVES: Record<string, (index: number, count: number) => number> = {
  ArrowDown: (index) => index + 1,
  ArrowRight: (index) => index + 1,
  ArrowUp: (index) => index - 1,
  ArrowLeft: (index) => index - 1,
  Home: () => 0,
  End: (_, count) => count - 1,
};

/**
 * Onglets verticaux de HomeProductTour (motif ARIA « tabs », activation automatique). Le contenu
 * de chaque onglet et de chaque panneau arrive déjà rendu par le serveur. Un onglet est nommé par
 * son texte visible (contrôle Axe label-content-name-mismatch) : son titre, plus sa description
 * quand il est sélectionné ; chaque panneau est nommé par le titre `product-tour-title-*`.
 */
export function ProductTourTabs({
  label,
  items,
  footer,
}: {
  label: string;
  items: Item[];
  footer: ReactNode;
}) {
  const [active, setActive] = useState(0);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const move = MOVES[event.key];
    if (!move) return;
    event.preventDefault();
    const next = (move(index, items.length) + items.length) % items.length;
    setActive(next);
    tabs.current[next]?.focus();
  }

  return (
    <div className={styles.layout}>
      <div className={styles.tabs} role="tablist" aria-label={label} aria-orientation="vertical">
        {items.map((item, index) => (
          <button
            key={item.id}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            className={styles.tab}
            type="button"
            role="tab"
            aria-selected={index === active}
            aria-controls={`product-tour-panel-${item.id}`}
            tabIndex={index === active ? 0 : -1}
            onClick={() => setActive(index)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {item.tab}
          </button>
        ))}
      </div>
      <div className={styles.screens}>
        {items.map((item, index) => (
          <div
            key={item.id}
            id={`product-tour-panel-${item.id}`}
            role="tabpanel"
            aria-labelledby={`product-tour-title-${item.id}`}
            hidden={index !== active}
          >
            {item.panel}
          </div>
        ))}
        {footer}
      </div>
    </div>
  );
}
