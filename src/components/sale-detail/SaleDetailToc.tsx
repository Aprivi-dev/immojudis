"use client";

import { useEffect, useRef } from "react";
import {
  SALE_DETAIL_SECTIONS,
  type SaleDetailSection,
} from "@/components/sale-detail/sale-detail-anchors";
import styles from "./SaleDetailLayout.module.css";

/**
 * Sommaire numéroté de la fiche, collé sous l'en-tête du site : six liens vers les sections, la
 * section courante mise en avant (`aria-current`). Sur téléphone, des pilules qui défilent à
 * l'horizontale ; la pilule courante est ramenée en vue. `data-sale-tabs` dit à `html` (styles.css)
 * de réserver la hauteur de la barre pour le focus et les ancres.
 */
export function SaleDetailToc({ active }: { active: SaleDetailSection | null }) {
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const link = list?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!list || !link || list.scrollWidth <= list.clientWidth) return;
    list.scrollLeft = link.offsetLeft - list.offsetLeft - (list.clientWidth - link.clientWidth) / 2;
  }, [active]);

  return (
    <nav className={styles.toc} aria-label="Sommaire de la fiche" data-sale-tabs="">
      <ol ref={listRef} className={styles.tocList}>
        {SALE_DETAIL_SECTIONS.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={styles.tocLink}
              // Le nom reste le libellé complet, y compris sous la pilule courte du téléphone.
              aria-label={section.label}
              aria-current={active === section.id ? "true" : undefined}
            >
              <span className={styles.tocNumber}>{section.number}</span>
              <span className={styles.tocLabel}>{section.label}</span>
              <span className={styles.tocShort}>{section.shortLabel}</span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/**
 * Met en avant la section lue : celle qui traverse la bande située entre 30 % et 40 % de la hauteur
 * de l'écran. Sans `IntersectionObserver`, la section courante reste celle choisie par les liens.
 */
export function useSectionSpy(onSection: (section: SaleDetailSection) => void) {
  const callback = useRef(onSection);
  useEffect(() => {
    callback.current = onSection;
  });
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) callback.current(entry.target.id as SaleDetailSection);
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const section of SALE_DETAIL_SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);
}
