"use client";

import { useEffect, useMemo, useRef } from "react";
import type { KeyboardEvent } from "react";
import { useState } from "react";
import Check from "lucide-react/dist/esm/icons/check.js";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.js";
import ChevronUp from "lucide-react/dist/esm/icons/chevron-up.js";
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
  { id: "estimation", label: "Estimation" },
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
};

export function SaleDetailTabNav({
  activeTab,
  onTabChange,
  showStatistics = false,
}: SaleDetailTabNavProps) {
  const tabs = useMemo(
    () => SALE_DETAIL_TABS.filter((tab) => showStatistics || tab.id !== "statistiques"),
    [showStatistics],
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const navRef = useRef<HTMLElement>(null);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileOptionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const tabListRef = useRef<HTMLDivElement>(null);
  const activeTabLabel = tabs.find((tab) => tab.id === activeTab)?.label ?? tabs[0].label;
  const mobileMenuId = "sale-detail-mobile-menu";

  useEffect(() => {
    if (!mobileMenuOpen) return;

    const activeIndex = tabs.findIndex((tab) => tab.id === activeTab);
    mobileOptionRefs.current[activeIndex >= 0 ? activeIndex : 0]?.focus();

    function onPointerDown(event: PointerEvent) {
      if (!navRef.current?.contains(event.target as Node)) setMobileMenuOpen(false);
    }

    function onFocusIn(event: FocusEvent) {
      if (!navRef.current?.contains(event.target as Node)) setMobileMenuOpen(false);
    }

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape") return;
      setMobileMenuOpen(false);
      mobileTriggerRef.current?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [activeTab, mobileMenuOpen, tabs]);

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

  const focusMobileOption = (index: number) => {
    const nextIndex = (index + tabs.length) % tabs.length;
    mobileOptionRefs.current[nextIndex]?.focus();
  };

  const handleMobileOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentTab: SaleDetailTab,
  ) => {
    const currentIndex = tabs.findIndex((tab) => tab.id === currentTab);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = currentIndex + 1;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = currentIndex - 1;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else if (event.key === "Escape") {
      event.preventDefault();
      setMobileMenuOpen(false);
      mobileTriggerRef.current?.focus();
      return;
    }

    if (nextIndex == null) return;

    event.preventDefault();
    focusMobileOption(nextIndex);
  };

  const selectMobileTab = (tab: SaleDetailTab) => {
    setMobileMenuOpen(false);
    onTabChange(tab);
    mobileTriggerRef.current?.focus();
  };

  return (
    <nav ref={navRef} className={styles.nav} aria-label="Navigation de l'annonce">
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
      </div>

      <div className={styles.mobileControl}>
        {mobileMenuOpen ? (
          <div
            id={mobileMenuId}
            className={styles.mobileMenu}
            role="menu"
            aria-label="Sections de l'annonce"
            aria-orientation="vertical"
          >
            {tabs.map((tab, index) => {
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  ref={(element) => {
                    mobileOptionRefs.current[index] = element;
                  }}
                  className={`${styles.mobileOption} ${isActive ? styles.mobileOptionActive : ""}`}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  onClick={() => selectMobileTab(tab.id)}
                  onKeyDown={(event) => handleMobileOptionKeyDown(event, tab.id)}
                >
                  <span>{tab.label}</span>
                  <span className={styles.mobileOptionCheck} aria-hidden="true">
                    {isActive ? <Check className={styles.mobileOptionIcon} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        <button
          ref={mobileTriggerRef}
          className={styles.mobileTrigger}
          type="button"
          aria-label={`Explorer : ${activeTabLabel}`}
          aria-controls={mobileMenuId}
          aria-expanded={mobileMenuOpen}
          aria-haspopup="menu"
          onClick={() => setMobileMenuOpen((open) => !open)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            setMobileMenuOpen(true);
          }}
        >
          <span className={styles.mobileTriggerLabel}>Explorer :</span>
          <span className={styles.mobileTriggerCurrent}>{activeTabLabel}</span>
          <span className={styles.mobileTriggerChevron} aria-hidden="true">
            {mobileMenuOpen ? (
              <ChevronUp className={styles.mobileTriggerIcon} />
            ) : (
              <ChevronDown className={styles.mobileTriggerIcon} />
            )}
          </span>
        </button>
      </div>
    </nav>
  );
}
