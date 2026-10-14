// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WELL_INFORMED_BADGE_NOTE, WellInformedBadge } from "./WellInformedBadge";

afterEach(cleanup);

describe("WellInformedBadge", () => {
  it("affiche « Annonce bien renseignée » pour une annonce du palier haut", () => {
    render(<WellInformedBadge sale={{ completeness_tier: 1 }} />);
    expect(screen.getByText("Annonce bien renseignée", { exact: false })).toBeTruthy();
  });

  it("garde le libellé visible, cache l'icône et expose la portée du repère en texte masqué", () => {
    const { container } = render(<WellInformedBadge sale={{ completeness_tier: 1 }} />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.firstChild?.nextSibling?.textContent).toBe("Annonce bien renseignée");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    const note = badge.querySelector(".sr-only");
    expect(note?.textContent).toContain(WELL_INFORMED_BADGE_NOTE);
    expect(WELL_INFORMED_BADGE_NOTE).toContain("Fiche détaillée");
    expect(WELL_INFORMED_BADGE_NOTE).toContain("score de complétude d’au moins 40 sur 100");
    expect(WELL_INFORMED_BADGE_NOTE).not.toContain("décision prête");
    expect(WELL_INFORMED_BADGE_NOTE).toContain("pas leur exactitude");
    expect(WELL_INFORMED_BADGE_NOTE).toContain("ni vérification ni garantie sur le bien");
    expect(WELL_INFORMED_BADGE_NOTE).toContain("pièces officielles de la vente");
  });

  it("n'utilise pas d'attribut title, inaccessible au clavier et au tactile", () => {
    const { container } = render(<WellInformedBadge sale={{ completeness_tier: 1 }} />);
    expect(container.querySelector("[title]")).toBeNull();
  });

  it.each([{ completeness_tier: 0 }, { completeness_tier: null }, {}])(
    "n'affiche rien pour %j",
    (sale) => {
      const { container } = render(<WellInformedBadge sale={sale} />);
      expect(container.firstChild).toBeNull();
    },
  );
});
