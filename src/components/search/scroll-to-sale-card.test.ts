// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scrollToSaleCard } from "./scroll-to-sale-card";

function mountCard(rect: { top: number; bottom: number }) {
  const card = document.createElement("a");
  card.id = "sale-card-sale-1";
  card.scrollIntoView = vi.fn();
  card.getBoundingClientRect = () => ({ ...rect }) as DOMRect;
  document.body.append(card);
  return card;
}

describe("scrollToSaleCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("défile en douceur jusqu'à la carte sale-card-<id>, sans rien corriger si elle est centrée", () => {
    const card = mountCard({ top: 300, bottom: 500 });
    scrollToSaleCard("sale-1");
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });

    vi.advanceTimersByTime(2000);
    expect(card.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("défile d'un coup au retour d'une fiche (behavior: instant)", () => {
    const card = mountCard({ top: 300, bottom: 500 });
    scrollToSaleCard("sale-1", { behavior: "instant" });
    expect(card.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
  });

  it("recentre d'un coup si la hauteur estimée des cartes a décalé la cible", () => {
    const card = mountCard({ top: 640, bottom: 840 });
    scrollToSaleCard("sale-1");
    vi.advanceTimersByTime(2000);

    expect(card.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(card.scrollIntoView).toHaveBeenLastCalledWith({
      block: "center",
      behavior: "instant",
    });
  });

  it("ne plante pas si la carte n'existe pas dans la liste (vue ou page différente)", () => {
    expect(() => {
      scrollToSaleCard("absent");
      vi.advanceTimersByTime(2000);
    }).not.toThrow();
  });
});
