"use client";

import { useEffect, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useSectionSpy } from "@/components/sale-detail/SaleDetailToc";
import { focusUnlockPanel, UNLOCK_PANEL_ID } from "@/components/sale-detail/UnlockCallToAction";
import {
  type LegacyDetail,
  legacyDetailForAnchor,
  revealAnchor,
  type SaleDetailSection,
  sectionForAnchor,
} from "@/components/sale-detail/sale-detail-anchors";

/**
 * Navigation par ancres de la fiche vente : section mise en avant dans le sommaire, sections dont
 * une ancre a demandé les blocs lourds, blocs repliés ouverts par une ancre (`#budget`…), et suivi
 * de l'adresse (`#…`) comme des clics sur les liens internes.
 */
export function useSaleDetailAnchors({
  statisticsAvailable,
  budgetTarget,
}: {
  statisticsAvailable: boolean;
  budgetTarget: string;
}) {
  const [activeSection, setActiveSection] = useState<SaleDetailSection>("bien");
  // Sections dont une ancre a demandé les blocs lourds : ils sont montés sans attendre le défilement.
  const [forcedSections, setForcedSections] = useState<ReadonlySet<SaleDetailSection>>(
    () => new Set(),
  );
  const [anchorVisit, setAnchorVisit] = useState(0);
  const [expandedDetails, setExpandedDetails] = useState<Partial<Record<LegacyDetail, boolean>>>(
    {},
  );
  const setDetailOpen = (detail: LegacyDetail, open: boolean) => {
    setExpandedDetails((current) =>
      current[detail] === open ? current : { ...current, [detail]: open },
    );
  };
  const forceSection = (section: SaleDetailSection) => {
    setForcedSections((current) =>
      current.has(section) ? current : new Set(current).add(section),
    );
  };
  const forced = (section: SaleDetailSection) => forcedSections.has(section);

  useSectionSpy(setActiveSection);

  useEffect(() => {
    const syncWithHash = () => {
      const anchor = window.location.hash.slice(1);
      if (!anchor) return;
      const section = sectionForAnchor(anchor, statisticsAvailable);
      if (section) {
        setActiveSection(section);
        forceSection(section);
      }
      const detail = legacyDetailForAnchor(anchor, budgetTarget);
      if (detail) setDetailOpen(detail, true);
      setAnchorVisit((current) => current + 1);
    };
    syncWithHash();
    window.addEventListener("hashchange", syncWithHash);
    return () => window.removeEventListener("hashchange", syncWithHash);
  }, [budgetTarget, statisticsAvailable]);

  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchorVisit || !anchor) return;
    revealAnchor(anchor, budgetTarget, statisticsAvailable);
  }, [anchorVisit, budgetTarget, statisticsAvailable]);

  // Va à une ancre de la fiche : l'adresse la garde (la fiche débloquée, montée à la place de la
  // fiche gratuite, la relit), sa section est montée et mise en avant dans le sommaire.
  const goToAnchor = (anchor: string) => {
    window.history.pushState(null, "", `#${anchor}`);
    const section = sectionForAnchor(anchor, statisticsAvailable);
    if (section) {
      setActiveSection(section);
      forceSection(section);
    }
    const detail = legacyDetailForAnchor(anchor, budgetTarget);
    if (detail) setDetailOpen(detail, true);
    setAnchorVisit((current) => current + 1);
  };

  const handleSectionLink = (event: ReactMouseEvent<HTMLElement>) => {
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    const link = origin.closest<HTMLAnchorElement>('a[href^="#"]');
    const anchor = link?.getAttribute("href")?.slice(1);
    if (!anchor) return;
    // La carte de déblocage est au-dessus du sommaire : on y va sans toucher à l'adresse.
    if (anchor === UNLOCK_PANEL_ID) {
      if (focusUnlockPanel()) event.preventDefault();
      return;
    }
    const section = sectionForAnchor(anchor, statisticsAvailable);
    if (!section) return;
    setActiveSection(section);
    // Le lecteur va à cette section : ses blocs lourds se chargent sans attendre le défilement.
    forceSection(section);
    const detail = legacyDetailForAnchor(anchor, budgetTarget);
    if (detail) setDetailOpen(detail, true);
    const target = document.getElementById(anchor);
    // La cible est dans la page et visible : le navigateur s'en charge.
    if (target && !target.closest("details:not([open])")) return;
    event.preventDefault();
    goToAnchor(anchor);
  };

  return {
    activeSection,
    forced,
    expandedDetails,
    setDetailOpen,
    goToAnchor,
    handleSectionLink,
  };
}
