// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import {
  PepiteExplanation,
  PepiteHeroBadge,
  PepiteIcon,
  PepiteInfoBadge,
  PepitePill,
} from "./PepiteBadge";

afterEach(cleanup);

const EXPLANATION =
  "Repère calculé automatiquement par Immojudis sur des critères publics. Ce n'est ni un conseil, ni une recommandation d'acheter, ni une garantie de prix.";

describe("pictogramme de pépite", () => {
  it("est décoratif, en couleurs du système visuel (aucune couleur en dur)", () => {
    const { container } = render(<PepiteIcon />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("class")).toContain("size-4");
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,6}|rgb\(/i);
    expect(container.innerHTML).toMatch(/fill-gold-light/);
    expect(container.innerHTML).toMatch(/stroke-gold/);
    // Aucune animation (pas de scintillement).
    expect(container.innerHTML).not.toMatch(/animate|<animate|transition/);
  });
});

describe("pastille « Pépite »", () => {
  it("est opaque blanche, bordure et logo or, texte or foncé, 12 px au moins", () => {
    render(<PepitePill />);
    const pill = screen.getByTestId("pepite-badge");
    expect(pill.textContent).toBe("Pépite");
    expect(pill.className).toMatch(/border-gold/);
    expect(pill.className).toMatch(/\bbg-white\b/);
    expect(pill.className).toMatch(/text-gold-text/);
    // Ni fond or plein (« Débloquée »), ni transparence.
    expect(pill.className).not.toMatch(/bg-gold\b|bg-white\/|bg-gold\//);
    expect(pill.className).toMatch(/text-caption/);
    expect(pill.className).not.toMatch(/text-\[(?:\d|1[01])px\]|text-\[10px\]|text-\[11px\]/);
    expect(pill.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("le lien « Pourquoi ? » de la fiche mène au bloc #pepite", () => {
    render(<PepiteHeroBadge />);
    expect(screen.getByText("Pépite")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Pourquoi ?" }).getAttribute("href")).toBe("#pepite");
  });
});

describe("explication accessible au clavier et au toucher", () => {
  it("ouvre le texte validé et le lien vers la méthode, referme avec Échap", () => {
    render(<PepiteInfoBadge />);
    expect(screen.queryByRole("note")).toBeNull();
    const button = screen.getByRole("button", { name: "Pépite" });
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);
    const note = screen.getByRole("note");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(note.id);
    expect(note.textContent).toContain(EXPLANATION);
    expect(
      screen
        .getByRole("link", { name: "Comment repérons-nous les pépites ?" })
        .getAttribute("href"),
    ).toBe("/methode-pepites");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("se referme au second appui", () => {
    render(<PepiteInfoBadge />);
    const button = screen.getByRole("button", { name: "Pépite" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("la variante icône (tableau) garde un nom accessible en texte, pas seulement le dessin", () => {
    render(<PepiteInfoBadge variant="icon" />);
    const button = screen.getByRole("button", { name: "Pépite" });
    expect(button.querySelector(".sr-only")?.textContent).toBe("Pépite");
    expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });

  it("n'a pas de défaut d'accessibilité, fermée comme ouverte", async () => {
    const { container } = render(
      <main>
        <PepiteInfoBadge />
        <PepiteExplanation />
      </main>,
    );
    expect((await axe(container)).violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Pépite" }));
    expect((await axe(container)).violations).toEqual([]);
  });
});

describe("fenêtre d'aide : fermeture et rognage", () => {
  function inClippingContainers() {
    return render(
      <div>
        <div className="overflow-hidden" data-testid="photo">
          <div className="overflow-x-auto" data-testid="table">
            <PepiteInfoBadge />
          </div>
        </div>
        <button type="button">Ailleurs</button>
      </div>,
    );
  }

  it("est rendue hors de la photo et du tableau (portail, position fixe), donc jamais rognée", () => {
    inClippingContainers();
    fireEvent.click(screen.getByRole("button", { name: "Pépite" }));
    const note = screen.getByRole("note");
    expect(screen.getByTestId("photo").contains(note)).toBe(false);
    expect(screen.getByTestId("table").contains(note)).toBe(false);
    const panel = note.parentElement!;
    expect(panel.parentElement).toBe(document.body);
    expect(panel.className).toMatch(/\bfixed\b/);
    // Reste dans l'écran d'une carte étroite : largeur bornée à celle de la fenêtre.
    expect(panel.className).toMatch(/max-w-\[calc\(100vw-1rem\)\]/);
    expect(Number.parseFloat(panel.style.left)).toBeGreaterThanOrEqual(8);
  });

  it("se ferme à un appui à l'extérieur, pas à un appui dans la fenêtre", () => {
    inClippingContainers();
    fireEvent.click(screen.getByRole("button", { name: "Pépite" }));
    fireEvent.pointerDown(screen.getByRole("note"));
    expect(screen.queryByRole("note")).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("se ferme quand le focus quitte la pastille, et reste ouverte quand il va sur le lien de la fenêtre", () => {
    inClippingContainers();
    const button = screen.getByRole("button", { name: "Pépite" });
    fireEvent.click(button);
    const link = screen.getByRole("link", { name: "Comment repérons-nous les pépites ?" });
    fireEvent.blur(button, { relatedTarget: link });
    expect(screen.queryByRole("note")).not.toBeNull();
    fireEvent.blur(link, { relatedTarget: screen.getByRole("button", { name: "Ailleurs" }) });
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("se ferme au défilement et au redimensionnement", () => {
    inClippingContainers();
    const button = screen.getByRole("button", { name: "Pépite" });
    fireEvent.click(button);
    fireEvent.scroll(window);
    expect(screen.queryByRole("note")).toBeNull();
    fireEvent.click(button);
    fireEvent.resize(window);
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("mention « exposé » (périmètre d'un PPRi)", () => {
  const SHORT =
    "Dans le périmètre d’un plan de prévention des risques d’inondation (PPRi) : zonage à vérifier.";

  it("la pastille de la fiche porte la mention courte", () => {
    render(<PepiteHeroBadge floodExposed />);
    expect(screen.getByTestId("pepite-flood-exposed").textContent).toBe(SHORT);
  });

  it("sans exposition, aucune mention", () => {
    render(<PepiteHeroBadge />);
    expect(screen.queryByTestId("pepite-flood-exposed")).toBeNull();
  });

  it("la pastille d'une carte annonce la mention aux lecteurs d'écran et la répète dans sa fenêtre d'aide", () => {
    render(<PepiteInfoBadge floodExposed />);
    const button = screen.getByRole("button");
    expect(button.textContent).toContain(SHORT);
    fireEvent.click(button);
    expect(screen.getByRole("note").textContent).toContain(SHORT);
  });

  it("la version icône garde la mention dans son nom accessible", () => {
    render(<PepiteInfoBadge variant="icon" floodExposed />);
    expect(screen.getByRole("button", { name: `Pépite. ${SHORT}` })).toBeTruthy();
  });

  it("sans exposition, la pastille ne dit que « Pépite »", () => {
    render(<PepiteInfoBadge variant="icon" />);
    expect(screen.getByRole("button", { name: "Pépite" })).toBeTruthy();
  });
});
