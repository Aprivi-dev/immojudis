// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { PointToVerify } from "@/lib/search/points-to-verify";
import { PointsToVerifyBadge } from "./PointsToVerifyBadge";

afterEach(cleanup);

const POINTS: PointToVerify[] = [
  { key: "surface", label: "Surface non communiquée dans l’annonce" },
  { key: "occupancy", label: "Occupation du bien à confirmer" },
  { key: "date", label: "Date de la vente à confirmer" },
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
    expect(link.getAttribute("href")).toBe("/sales/sale-1");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(badge);
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
