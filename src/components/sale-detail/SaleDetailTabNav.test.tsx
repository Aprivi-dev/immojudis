// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SaleDetailTabNav, type SaleDetailTab } from "./SaleDetailTabNav";

afterEach(cleanup);

function Harness() {
  const [activeTab, setActiveTab] = useState<SaleDetailTab>("apercu");
  return <SaleDetailTabNav activeTab={activeTab} onTabChange={setActiveTab} />;
}

describe("SaleDetailTabNav", () => {
  it("exposes a single selected tab with the five primary sections", () => {
    render(<Harness />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(5);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Aperçu",
      "Estimation",
      "Travaux",
      "Financement",
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
    expect(tabs[4].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[4]);

    fireEvent.keyDown(tabs[4], { key: "Home" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[0]);

    fireEvent.keyDown(tabs[0], { key: "ArrowLeft" });
    expect(tabs[4].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[4]);
  });
});
