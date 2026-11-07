"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  SALE_DETAIL_SECTIONS,
  type SaleDetailSection,
} from "@/components/sale-detail/sale-detail-anchors";
import styles from "./SaleDetailLayout.module.css";

/**
 * Une section numérotée de la fiche (« 01 Le bien »…). Le titre est un `h2` ; l'id de la section est
 * la cible du sommaire et des ancres (`sale-detail-anchors.ts`).
 */
export function DetailSection({
  id,
  title,
  intro,
  children,
}: {
  id: SaleDetailSection;
  /** Titre propre à la vente (« Prix et offre plafond »…) ; absent : celui du sommaire. */
  title?: string;
  intro?: ReactNode;
  children: ReactNode;
}) {
  const section = SALE_DETAIL_SECTIONS.find((item) => item.id === id)!;
  const titleId = `${id}-title`;
  return (
    <section id={id} className={styles.section} aria-labelledby={titleId}>
      <p className={styles.sectionNumber} aria-hidden>
        {section.number}
      </p>
      <div className={styles.sectionBody}>
        <h2 id={titleId} className={styles.sectionTitle}>
          {title ?? section.label}
        </h2>
        {intro ? <p className={styles.sectionIntro}>{intro}</p> : null}
        <div className={styles.sectionContent}>{children}</div>
      </div>
    </section>
  );
}

/**
 * Monte un bloc lourd (chargé à la demande) quand sa place approche de l'écran, à 800 px près, ou
 * dès qu'une ancre le demande (`force`) : la fiche sur une seule page garde le chargement différé
 * des anciens onglets, et le JavaScript comme les requêtes de ces blocs n'arrivent qu'à l'approche.
 * Sans `IntersectionObserver` (vieux navigateur, rendu de test), le bloc est monté tout de suite.
 */
export function WhenNear({
  force = false,
  placeholder,
  minHeight = 240,
  children,
}: {
  force?: boolean;
  /** Ce qui tient la place du bloc avant son montage (texte court). */
  placeholder: string;
  minHeight?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  // Une fois demandé par une ancre, le bloc reste monté.
  if (force && !near) setNear(true);
  useEffect(() => {
    if (near) return;
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near]);
  if (near) return <>{children}</>;
  return (
    <div ref={ref} className={styles.deferred} style={{ minHeight }}>
      <p>{placeholder}</p>
    </div>
  );
}
