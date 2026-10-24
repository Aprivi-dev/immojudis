// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { HomeProductTour, PRODUCT_TOUR_SCREENS } from "./HomeProductTour";

afterEach(cleanup);

describe("HomeProductTour", () => {
  it("shows one screen at a time, named by its tab", () => {
    render(<HomeProductTour />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "La carte des ventes" })).toBe(tabs[0]);

    fireEvent.click(screen.getByRole("tab", { name: "L’enchère plafond" }));
    expect(screen.getByRole("tabpanel", { name: "L’enchère plafond" })).toBeTruthy();
  });

  it("moves between screens with the arrow keys, Home and End", () => {
    render(<HomeProductTour />);
    const tabs = screen.getAllByRole("tab");
    fireEvent.keyDown(tabs[0], { key: "ArrowDown" });
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tabs[1]);
    fireEvent.keyDown(tabs[1], { key: "End" });
    expect(tabs[3].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[3], { key: "ArrowRight" });
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tabs[0], { key: "ArrowUp" });
    expect(tabs[3].getAttribute("aria-selected")).toBe("true");
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toEqual([tabs[3]]);
  });

  it("labels every screen of the fictional example as such", () => {
    for (const item of PRODUCT_TOUR_SCREENS) {
      if (item.id === "carte") continue;
      expect(item.badge).toBe("Exemple fictif");
      expect(item.alt).toMatch(/exemple fictif/i);
    }
  });

  it("keeps the Analyse-only details and the simulation stated", () => {
    const byId = Object.fromEntries(PRODUCT_TOUR_SCREENS.map((item) => [item.id, item]));
    expect(byId.estimation.description).toContain("inclus dans Analyse");
    expect(byId.plafond.description).toContain("Simulation, pour les ventes au tribunal");
  });
});
