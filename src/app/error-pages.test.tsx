// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    const reset = vi.fn();
    render(<ErrorPage error={new Error("boom")} reset={reset} />);
    expect(screen.getByRole("heading", { name: "Cette page n’a pas chargé" })).toBeTruthy();
    expect(document.title).toBe("Cette page n’a pas chargé");
    fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
    expect(reset).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "Retour à l’accueil" })).toBeTruthy();
  });

  it("n'expose jamais le message technique", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorPage error={new Error("relation auction_sales does not exist")} reset={vi.fn()} />,
    );
    expect(screen.queryByText(/auction_sales/)).toBeNull();
  });
});

describe("erreur globale", () => {
  it("reprend la charte actuelle (clair, bouton marine sur or)", () => {
    const html = (() => {
      const { container } = render(<GlobalError error={new Error("x")} reset={vi.fn()} />, {
        container: document.createElement("div"),
      });
      return container.innerHTML;
    })();
    expect(html).toContain("rgb(238, 247, 255)");
    expect(html).toContain("Réessayer");
    expect(html).not.toContain("rgb(7, 17, 31)");
  });
});
