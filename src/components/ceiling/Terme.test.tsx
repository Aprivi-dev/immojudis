// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { axe } from "vitest-axe";
import { afterEach, describe, expect, it } from "vitest";
import { Terme } from "./Terme";

afterEach(cleanup);

describe("Terme", () => {
  it("shows the word and a help button that opens a short definition", () => {
    render(
      <p>
        <Terme terme="surenchere">surenchère</Terme>
      </p>,
    );
    const button = screen.getByRole("button", { name: "Définition : surenchère" });

    expect(screen.getByText("surenchère")).toBeTruthy();
    expect(screen.queryByRole("note")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(button);

    const note = screen.getByRole("note");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(button.getAttribute("aria-controls")).toBe(note.id);
    expect(note.textContent).toContain("Offre formée après une adjudication");
    expect(screen.getByRole("link", { name: "En savoir plus" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#lexique",
    );
  });

  it("closes on Escape, giving the focus back to the button", () => {
    render(<Terme terme="portage" />);
    const button = screen.getByRole("button", { name: "Définition : portage" });

    fireEvent.click(button);
    expect(screen.getByRole("note")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("note")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes on a click outside, and toggles with the button", () => {
    render(
      <div>
        <Terme terme="liberation" />
        <span>ailleurs</span>
      </div>,
    );
    const button = screen.getByRole("button", { name: "Définition : libération du bien" });

    fireEvent.click(button);
    expect(screen.getByRole("note")).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("ailleurs"));
    expect(screen.queryByRole("note")).toBeNull();

    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("has no structural accessibility violation, open or closed", async () => {
    const { container } = render(
      <p>
        <Terme terme="emoluments">émoluments</Terme>
      </p>,
    );
    expect(
      (await axe(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Définition : émoluments" }));
    expect(
      (await axe(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
