"use client";

import { useEffect, useState } from "react";
import styles from "./SalePublicPreview.module.css";

export type SalePublicTocItem = { id: string; number: string; label: string };

/**
 * Sommaire numéroté de la fiche publique, collant sous l'en-tête du site : la section lue est mise
 * en avant (`aria-current`). Le serveur rend la première comme courante ; une fois monté, le
 * navigateur suit le défilement (IntersectionObserver, bande du tiers supérieur de l'écran). Sans
 * IntersectionObserver, le sommaire reste une simple liste de liens.
 */
export function SalePublicToc({ items }: { items: readonly SalePublicTocItem[] }) {
  const [current, setCurrent] = useState(items[0]?.id ?? null);
  const ids = items.map((item) => item.id).join(" ");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const targets = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((node): node is HTMLElement => node !== null);
    if (targets.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setCurrent(entry.target.id);
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, [ids]);

  return (
    <nav className={styles.toc} aria-label="Sommaire de la fiche">
      <ol>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={`#${item.id}`}
              aria-current={current === item.id ? "true" : undefined}
              onClick={() => setCurrent(item.id)}
            >
              <span aria-hidden>{item.number}</span>
              {item.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
