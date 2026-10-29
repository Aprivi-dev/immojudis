// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SaleDetailTabNav, type SaleDetailTab } from "./SaleDetailTabNav";

afterEach(cleanup);

function Harness({ showStatistics = false }: { showStatistics?: boolean }) {
  const [activeTab, setActiveTab] = useState<SaleDetailTab>("apercu");
  return (
    <SaleDetailTabNav
      activeTab={activeTab}
      onTabChange={setActiveTab}
      showStatistics={showStatistics}
    />
  );
}

describe("SaleDetailTabNav", () => {
  it("adds the tribunal statistics section to the keyboard navigation", () => {
    render(<Harness showStatistics />);
    expect(screen.getAllByRole("tab")).toHaveLength(7);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Prix et plafond" }), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "Statistiques" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Statistiques" }));
  });
  it("exposes a single selected tab with the six primary sections", () => {
    render(<Harness />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Aperçu",
      "Prix et plafond",
      "Travaux",
      "Financement",
      "Quartier",
      "Démarches",
    ]);
    expect(tabs.filter((tab) => tab.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].getAttribute("tabindex")).toBe("0");
    expect(tabs[1].getAttribute("tabindex")).toBe("-1");
  });

  it("moves selection and focus with arrow keys, Home, and End", () => {
    render(<Harness />);

    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);

    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(tabs[5].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[5]);

    fireEvent.keyDown(tabs[5], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[5].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[5]);
  });

  it("keeps one row of tabs on every screen, with no separate menu", () => {
    render(<Harness />);

    expect(screen.getAllByRole("tablist")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Explorer/ })).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("has no navigation landmark and points aria-controls at the one rendered panel only", () => {
    const { container } = render(<Harness />);

    expect(screen.queryByRole("navigation")).toBeNull();
    expect(container.querySelector("[data-sale-tabs]")?.getAttribute("role")).toBe("presentation");
    const tabs = screen.getAllByRole("tab");
    expect(tabs[0].getAttribute("aria-controls")).toBe("sale-detail-panel-apercu");
    expect(tabs.slice(1).map((tab) => tab.getAttribute("aria-controls"))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("recalls the two prices beside the tabs, and only the known ones", () => {
    const { rerender, container } = render(
      <SaleDetailTabNav
        activeTab="apercu"
        onTabChange={() => undefined}
        priceRecall={{ startingPrice: 95_000, ceiling: 171_000 }}
      />,
    );
    const recall = container.querySelector("[aria-hidden='true']")?.textContent ?? "";
    expect(recall).toMatch(/Mise à prix 95\s000\s€/);
    expect(recall).toMatch(/Plafond 171\s000\s€/);

    rerender(
      <SaleDetailTabNav
        activeTab="apercu"
        onTabChange={() => undefined}
        priceRecall={{ startingPrice: 95_000, ceiling: null }}
      />,
    );
    expect(container.textContent).not.toContain("Plafond");
  });
});
