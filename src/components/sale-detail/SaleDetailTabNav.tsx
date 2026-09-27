"use client";

import { useEffect, useRef } from "react";
import type { KeyboardEvent } from "react";
import styles from "./SaleDetailTabNav.module.css";

export type SaleDetailTab = "apercu" | "estimation" | "travaux" | "financement" | "demarches";

export const SALE_DETAIL_TABS: ReadonlyArray<{
  id: SaleDetailTab;
  label: string;
}> = [
  { id: "apercu", label: "Aperçu" },
  { id: "estimation", label: "Estimation" },
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
};

export function SaleDetailTabNav({ activeTab, onTabChange }: SaleDetailTabNavProps) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = tabListRef.current;
    const tab = tabRefs.current[SALE_DETAIL_TABS.findIndex((item) => item.id === activeTab)];
    if (!list || !tab || list.scrollWidth <= list.clientWidth) return;
    list.scrollLeft = tab.offsetLeft - list.offsetLeft - (list.clientWidth - tab.clientWidth) / 2;
  }, [activeTab]);

  const focusTab = (tab: SaleDetailTab) => {
    const index = SALE_DETAIL_TABS.findIndex((item) => item.id === tab);
    if (index < 0) return;
    tabRefs.current[index]?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentTab: SaleDetailTab) => {
    const currentIndex = SALE_DETAIL_TABS.findIndex((item) => item.id === currentTab);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % SALE_DETAIL_TABS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + SALE_DETAIL_TABS.length) % SALE_DETAIL_TABS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = SALE_DETAIL_TABS.length - 1;
    }

    if (nextIndex == null) return;

    event.preventDefault();
    const nextTab = SALE_DETAIL_TABS[nextIndex].id;
    onTabChange(nextTab);
    focusTab(nextTab);
  };

  return (
    <nav className={styles.nav} aria-label="Navigation de l'annonce">
      <div className={styles.inner}>
        <span className={styles.eyebrow}>Explorer l'annonce</span>
        <div
          ref={tabListRef}
          className={styles.tabList}
          role="tablist"
          aria-label="Sections de l'annonce"
        >
          {SALE_DETAIL_TABS.map((tab, index) => {
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
      </div>
    </nav>
  );
}
