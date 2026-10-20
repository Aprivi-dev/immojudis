// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { PointToVerify } from "@/lib/search/points-to-verify";
import { PointsToVerifyBadge } from "./PointsToVerifyBadge";

afterEach(cleanup);

const POINTS: PointToVerify[] = [
  { key: "surface", label: "Surface non communiquée dans l’annonce" },
  { key: "occupancy", label: "Occupation du bien à vérifier" },
  { key: "date", label: "Date de la vente à vérifier" },
];

describe("PointsToVerifyBadge", () => {
  it("annonce le nombre de points, en termes neutres", () => {
    render(<PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />);
    const badge = screen.getByRole("button", { name: "3 points à vérifier" });
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    expect(badge.className).toContain("text-xs");
    expect(badge.className).not.toMatch(/uppercase|red|rose|amber|bg-destructive/);
  });

  it("ouvre la liste des points et le lien vers la fiche, au clic comme au clavier", () => {
    const onNavigate = vi.fn();
    render(
      <PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" onNavigate={onNavigate} />,
    );
    expect(screen.queryByRole("note")).toBeNull();
    const badge = screen.getByRole("button", { name: "3 points à vérifier" });
    fireEvent.click(badge);
    const note = screen.getByRole("note");
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(badge.getAttribute("aria-controls")).toBe(note.id);
    expect(Array.from(note.querySelectorAll("li")).map((item) => item.textContent)).toEqual(
      POINTS.map((point) => point.label),
    );
    expect(note.textContent).toContain("Le détail et les pièces figurent sur la fiche");
    const link = screen.getByRole("link", { name: "Voir la fiche" });
    // L'ancre mène aux points repris sur la fiche.
    expect(link.getAttribute("href")).toBe("/sales/sale-1#points-a-verifier");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(badge);
  });

  it("dit que la liste n'est pas exhaustive et que l'absence de pastille ne prouve rien", () => {
    render(<PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />);
    fireEvent.click(screen.getByRole("button", { name: "3 points à vérifier" }));
    expect(screen.getByRole("note").textContent).toContain(
      "Ces points sont ceux que l’annonce laisse ouverts. La liste n’est pas exhaustive : l’absence de pastille ne signifie pas qu’il n’y a rien à vérifier.",
    );
  });

  it("n'emploie qu'un verbe : « à vérifier », jamais « à confirmer »", () => {
    render(<PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />);
    fireEvent.click(screen.getByRole("button", { name: "3 points à vérifier" }));
    expect(document.body.textContent).not.toMatch(/à confirmer/);
  });

  it("garde un anneau de focus lisible et une zone d'appui de 44 px", () => {
    render(<PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />);
    const badge = screen.getByRole("button", { name: "3 points à vérifier" });
    expect(badge.className).toContain("focus-visible:outline-gold-soft");
    expect(badge.className).not.toContain("ring-gold");
    // 24 px de pastille + 2 × 10 px de pseudo-élément = 44 px de haut.
    expect(badge.className).toContain("min-h-6");
    expect(badge.className).toContain("after:-inset-y-2.5");
  });

  it("ne se ferme pas avec Échap quand un dialogue est ouvert par-dessus", () => {
    render(<PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />);
    fireEvent.click(screen.getByRole("button", { name: "3 points à vérifier" }));
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.appendChild(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("note")).toBeTruthy();
    dialog.remove();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("laisse le dialogue qui a déjà pris Échap à lui seul", () => {
    render(<PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />);
    fireEvent.click(screen.getByRole("button", { name: "3 points à vérifier" }));
    const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);
    expect(screen.getByRole("note")).toBeTruthy();
  });

  it("en tableau : une icône au nom accessible, qui ouvre les mêmes points", () => {
    render(<PointsToVerifyBadge variant="icon" points={POINTS} detailHref="/sales/sale-1" />);
    const button = screen.getByRole("button", { name: "3 points à vérifier" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(button.className).toContain("after:-inset-2.5");
    expect(button.className).toContain("focus-visible:outline-gold-soft");
    fireEvent.click(button);
    expect(screen.getByRole("note").textContent).toContain("Occupation du bien à vérifier");
  });

  it("se referme en rappuyant sur la pastille", () => {
    render(<PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />);
    const badge = screen.getByRole("button", { name: "3 points à vérifier" });
    fireEvent.click(badge);
    fireEvent.click(badge);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("accorde le singulier", () => {
    render(<PointsToVerifyBadge points={POINTS.slice(0, 1)} detailHref="/sales/sale-1" />);
    expect(screen.getByRole("button", { name: "1 point à vérifier" })).toBeTruthy();
  });

  it("n'affiche rien sans point", () => {
    const { container } = render(<PointsToVerifyBadge points={[]} detailHref="/sales/sale-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("n'utilise pas d'attribut title et n'a pas de défaut d'accessibilité", async () => {
    const { container } = render(
      <PointsToVerifyBadge points={POINTS} detailHref="/sales/sale-1" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "3 points à vérifier" }));
    expect(container.querySelector("[title]")).toBeNull();
    const result = await axe(container, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.map(({ id, help }) => ({ id, help }))).toEqual([]);
  });
});
