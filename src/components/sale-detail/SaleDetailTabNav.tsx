"use client";

import { useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { formatPrice } from "@/lib/format";
import styles from "./SaleDetailTabNav.module.css";

export type SaleDetailTab =
  | "apercu"
  | "estimation"
  | "statistiques"
  | "travaux"
  | "financement"
  | "demarches";

export const SALE_DETAIL_TABS: ReadonlyArray<{
  id: SaleDetailTab;
  label: string;
}> = [
  { id: "apercu", label: "Aperçu" },
  { id: "estimation", label: "Prix et plafond" },
  { id: "statistiques", label: "Statistiques" },
  { id: "travaux", label: "Travaux" },
  { id: "financement", label: "Financement" },
  { id: "demarches", label: "Démarches" },
];

export function saleDetailTabId(tab: SaleDetailTab): string {
  return `sale-detail-tab-${tab}`;
}
export function saleDetailTabPanelId(tab: SaleDetailTab): string {
  return `sale-detail-panel-${tab}`;
}

export type SaleDetailTabNavProps = {
  activeTab: SaleDetailTab;
  onTabChange: (tab: SaleDetailTab) => void;
  showStatistics?: boolean;
  /**
   * Rappel des deux prix à droite de la barre (grand écran seulement) : la synthèse sort de l'écran
   * quand on lit les onglets. Un montant inconnu ou en cours de vérification n'est pas rappelé.
   */
  priceRecall?: { startingPrice: number | null; ceiling: number | null } | null;
};

/**
 * Barre d'onglets de la fiche, collée sous l'en-tête du site. Sur téléphone, les onglets défilent
 * à l'horizontale (l'onglet actif est ramené au centre) : on voit qu'il y en a d'autres sans ouvrir
 * de menu, et rien ne recouvre le contenu.
 */
export function SaleDetailTabNav({
  activeTab,
  onTabChange,
  showStatistics = false,
  priceRecall = null,
}: SaleDetailTabNavProps) {
  const tabs = useMemo(
    () => SALE_DETAIL_TABS.filter((tab) => showStatistics || tab.id !== "statistiques"),
    [showStatistics],
  );
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = tabListRef.current;
    const tab = tabRefs.current[tabs.findIndex((item) => item.id === activeTab)];
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    list.scrollLeft = tab.offsetLeft - list.offsetLeft - (list.clientWidth - tab.clientWidth) / 2;
  }, [activeTab, tabs]);

  const focusTab = (tab: SaleDetailTab) => {
    const index = tabs.findIndex((item) => item.id === tab);
    if (index < 0) return;
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentTab: SaleDetailTab) => {
    const currentIndex = tabs.findIndex((item) => item.id === currentTab);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }

    if (nextIndex == null) return;

    event.preventDefault();
    const nextTab = tabs[nextIndex].id;
    onTabChange(nextTab);
    focusTab(nextTab);
  };

  const recall = [
    priceRecall?.startingPrice != null
      ? { label: "Mise à prix", value: formatPrice(priceRecall.startingPrice), ceiling: false }
      : null,
    priceRecall?.ceiling != null
      ? { label: "Plafond", value: formatPrice(priceRecall.ceiling), ceiling: true }
      : null,
  ].filter((item) => item != null);

  return (
    <nav className={styles.nav} aria-label="Navigation de l'annonce">
      <div className={styles.inner}>
        <div
          ref={tabListRef}
          className={styles.tabList}
          role="tablist"
          aria-label="Sections de l'annonce"
        >
          {tabs.map((tab, index) => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                ref={(element) => {
                  tabRefs.current[index] = element;
                }}
                className={`${styles.tab} ${isActive ? styles.active : ""}`}
                id={saleDetailTabId(tab.id)}
                type="button"
                role="tab"
                aria-controls={saleDetailTabPanelId(tab.id)}
                aria-selected={isActive}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(event) => handleKeyDown(event, tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
        {recall.length ? (
          <p className={styles.recall} aria-hidden="true">
            {recall.map((item) => (
              <span key={item.label}>
                {item.label}{" "}
                <strong className={item.ceiling ? styles.recallCeiling : undefined}>
                  {item.value}
                </strong>
              </span>
            ))}
          </p>
        ) : null}
      </div>
    </nav>
  );
}
