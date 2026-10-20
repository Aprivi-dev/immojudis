// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WellInformedBadge } from "./WellInformedBadge";
import { WELL_INFORMED_BADGE_NOTE } from "./well-informed-copy";

afterEach(cleanup);

describe("WellInformedBadge", () => {
  it("affiche « Annonce bien renseignée » pour une annonce du palier haut", () => {
    render(<WellInformedBadge sale={{ completeness_tier: 1 }} />);
    expect(screen.getByText("Annonce bien renseignée")).toBeTruthy();
  });

  it("affiche la pastille à 12 px, sans majuscules forcées", () => {
    const { container } = render(<WellInformedBadge sale={{ completeness_tier: 1 }} />);
    const badge = container.firstElementChild as HTMLElement;
    expect(badge.className).toContain("text-xs");
    expect(badge.className).not.toContain("uppercase");
    expect(badge.className).not.toContain("text-[10px]");
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("garde la réserve visible à la demande, au clavier comme au toucher", () => {
    const { container } = render(<WellInformedBadge sale={{ completeness_tier: 1 }} />);
    expect(screen.queryByRole("note")).toBeNull();
    const button = screen.getByRole("button", {
      name: "À propos du repère « Annonce bien renseignée »",
    });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const note = screen.getByRole("note");
    expect(button.getAttribute("aria-controls")).toBe(note.id);
    expect(note.textContent).toContain(WELL_INFORMED_BADGE_NOTE);
    expect(WELL_INFORMED_BADGE_NOTE).toBe(
      "Cette annonce renseigne une part importante des informations que nous relevons (photos, surface, occupation, documents, etc.). Ce n’est ni une vérification ni une garantie d’exactitude.",
    );
    expect(note.textContent).not.toContain("Fiche détaillée");
    expect(screen.getByRole("link", { name: "Comment ça marche ?" }).getAttribute("href")).toBe(
      "/classement-des-annonces",
    );
    expect(container.querySelector(".sr-only")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("ne se ferme pas avec l'Échap d'un dialogue ouvert par-dessus", () => {
    render(<WellInformedBadge sale={{ completeness_tier: 1 }} />);
    fireEvent.click(screen.getByRole("button", { name: /À propos du repère/ }));
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
