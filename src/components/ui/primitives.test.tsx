// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Badge, Button, Card, Eyebrow, PageShell, buttonClasses } from "./primitives";

afterEach(cleanup);

describe("primitives", () => {
  it("Button est de type button par défaut et déclenche onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Valider</Button>);
    const button = screen.getByRole("button", { name: "Valider" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("le bouton principal porte du texte marine sur or (jamais blanc)", () => {
    const classes = buttonClasses({ variant: "primary" });
    expect(classes).toContain("bg-gold");
    expect(classes).toContain("text-brand-navy");
    expect(classes).not.toContain("text-white");
  });

  it("le bouton inactif est gris et lisible", () => {
    expect(buttonClasses()).toContain("disabled:bg-surface-tint");
    expect(buttonClasses()).toContain("disabled:text-ink-soft");
  });

  it("Card, Eyebrow et Badge n'emploient que des jetons", () => {
    const { container } = render(
      <>
        <Card as="article">c</Card>
        <Eyebrow>e</Eyebrow>
        <Badge tone="success">b</Badge>
      </>,
    );
    expect(container.innerHTML).not.toMatch(/\[#/);
    expect(container.querySelector("article")?.className).toContain("border-line");
  });

  it("aucune pastille ni bouton ne reprend une couleur Tailwind brute", () => {
    const tones = ["neutral", "gold", "success", "warning", "danger", "info"] as const;
    const { container } = render(
      <>
        {tones.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </>,
    );
    const classes = [container.innerHTML, buttonClasses({ variant: "danger" })].join(" ");
    expect(classes).not.toMatch(/-(?:red|amber|emerald|sky|slate|gray)-\d/);
    expect(classes).not.toMatch(/shadow-/);
  });

  it("chaque pastille garde la taille de texte des légendes, quel que soit son ton", () => {
    const tones = ["neutral", "gold", "success", "warning", "danger", "info"] as const;
    const { container } = render(
      <>
        {tones.map((tone) => (
          <Badge key={tone} tone={tone}>
            {tone}
          </Badge>
        ))}
      </>,
    );
    for (const badge of container.querySelectorAll("span")) {
      expect(badge.className.split(" ")).toContain("text-caption");
    }
  });

  it("PageShell pose le contenu principal, un seul h1 et aucun décalage codé en dur", () => {
    const { container } = render(
      <PageShell eyebrow="Mon espace" title="Mes alertes">
        <p>contenu</p>
      </PageShell>,
    );
    const main = container.querySelector("main")!;
    expect(main.id).toBe("contenu");
    expect(main.className).not.toMatch(/pt-28/);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });
});
