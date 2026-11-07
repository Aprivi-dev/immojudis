// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_COLORS } from "@/lib/email-brand";
import ErrorPage from "./error";
import GlobalError from "./global-error";
import NotFound, { metadata } from "./not-found";

afterEach(cleanup);

describe("page 404", () => {
  it("porte le titre « Page introuvable » et des accents corrects", () => {
    expect(metadata.title).toBe("Page introuvable");
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Page introuvable" })).toBeTruthy();
    expect(screen.getByText(/La page demandée n’existe pas ou a été déplacée/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Retour à l’accueil" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "Voir les ventes" }).getAttribute("href")).toBe(
      "/sales",
    );
  });

  it("propose un champ de recherche qui ouvre le catalogue", () => {
    const { container } = render(<NotFound />);
    const form = container.querySelector("form[role='search']") as HTMLFormElement;
    expect(form.getAttribute("action")).toBe("/sales");
    expect(screen.getByLabelText(/Rechercher une vente/).getAttribute("name")).toBe("q");
  });
});

describe("page d'erreur", () => {
  it("annonce l'erreur en français, avec un titre, et permet de réessayer", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const retry = vi.fn();
    render(<ErrorPage error={new Error("boom")} retry={retry} />);
    expect(screen.getByRole("heading", { name: "Cette page n’a pas chargé" })).toBeTruthy();
    expect(document.title).toBe("Cette page n’a pas chargé");
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Retour à l’accueil" })).toBeTruthy();
  });

  it("n'expose jamais le message technique", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorPage error={new Error("relation auction_sales does not exist")} retry={vi.fn()} />,
    );
    expect(screen.queryByText(/auction_sales/)).toBeNull();
  });
});

describe("gabarit commun des pages d'état (repasse design n° 37)", () => {
  it("met la page 404 et la page d'erreur dans la même carte, avec le même titre de page", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<NotFound />);
    const notFoundTitle = screen.getByRole("heading", { level: 1 });
    const notFoundMain = notFoundTitle.closest("main")!;
    const notFoundClasses = [notFoundMain.className, notFoundTitle.className];
    expect(notFoundMain.id).toBe("contenu");
    unmount();

    render(<ErrorPage error={new Error("boom")} retry={vi.fn()} />);
    const errorTitle = screen.getByRole("heading", { level: 1 });
    expect([errorTitle.closest("main")!.className, errorTitle.className]).toEqual(notFoundClasses);
    expect(screen.getByRole("alert").contains(errorTitle)).toBe(true);
  });
});

describe("erreur globale", () => {
  it("reprend la charte actuelle : fond papier, carte blanche, bouton principal marine", () => {
    const retry = vi.fn();
    const { container } = render(<GlobalError error={new Error("x")} retry={retry} />, {
      container: document.createElement("div"),
    });
    const main = container.querySelector("main") as HTMLElement;
    expect(main.style.background).toBe("rgb(251, 249, 245)");
    const button = within(container).getByRole("button", { name: "Réessayer" });
    expect(button.style.background).toBe("rgb(19, 34, 56)");
    expect(button.style.color).toBe("rgb(255, 255, 255)");
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(
      within(container).getByRole("link", { name: "Retour à l’accueil" }).getAttribute("href"),
    ).toBe("/");
    expect(container.innerHTML).not.toContain("rgb(7, 17, 31)");
  });

  it("prend le papier de la charte dans EMAIL_COLORS, sans hexadécimal en dur", () => {
    const source = readFileSync(resolve("src/app/global-error.tsx"), "utf8");
    expect(EMAIL_COLORS.paper).toBe("#fbf9f5");
    expect(source).toContain("EMAIL_COLORS.paper");
    expect(source).not.toMatch(/#[0-9a-f]{6}\b/i);
  });
});
