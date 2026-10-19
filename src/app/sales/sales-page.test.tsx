// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SalesSearchParams } from "@/lib/search/search-url-state";

const state = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  searches: [] as unknown[],
}));

vi.mock("next/navigation", () => ({
  // Page statique : côté serveur `useSearchParams()` est vide ; dans le navigateur, c'est l'adresse.
  useSearchParams: () =>
    new URLSearchParams(
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => window.location.search,
        () => "",
      ),
    ),
}));
vi.mock("@/components/search/SearchPage", () => ({
  SearchPage: ({ search }: { search: SalesSearchParams }) => {
    state.searches.push(search);
    return <p data-testid="page">{`page ${search.page ?? 1}`}</p>;
  },
}));

import { SalesPage } from "./sales-page";

afterEach(() => {
  cleanup();
  state.searches = [];
  window.history.replaceState(null, "", "/");
});

describe("SalesPage : variante statique d'une page (/sales/defaut/2 servie à /sales?page=2)", () => {
  it("rend la page demandée côté serveur, où l'adresse est vide", () => {
    const html = renderToString(<SalesPage serverSeeded staticQuery="page=2" />);
    expect(html).toContain("page 2");
  });

  it("hydrate sans écart avec ce HTML, puis suit l'adresse du navigateur", async () => {
    const html = renderToString(<SalesPage serverSeeded staticQuery="page=2" />);
    window.history.replaceState(null, "", "/sales?page=2");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const errors: unknown[] = [];
    state.searches = [];

    await act(async () => {
      hydrateRoot(container, <SalesPage serverSeeded staticQuery="page=2" />, {
        onRecoverableError: (error) => errors.push(error),
      });
    });
    expect(errors).toEqual([]);
    expect(container.textContent).toBe("page 2");

    // Une fois hydratée, l'adresse du navigateur fait foi : un filtre ou une autre page.
    await act(async () => {
      window.history.replaceState(null, "", "/sales?page=4");
      state.listeners.forEach((listener) => listener());
    });
    expect(container.textContent).toBe("page 4");
    container.remove();
  });

  it("garde la même recherche pendant l'hydratation (pas de rendu de trop)", async () => {
    window.history.replaceState(null, "", "/sales?page=3");
    const html = renderToString(<SalesPage serverSeeded staticQuery="page=3" />);
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    state.searches = [];
    await act(async () => {
      hydrateRoot(container, <SalesPage serverSeeded staticQuery="page=3" />);
    });
    // Même objet de recherche avant et après : la page n'est pas relancée.
    const pages = new Set(state.searches.map((search) => (search as SalesSearchParams).page));
    expect(pages).toEqual(new Set([3]));
    container.remove();
  });
});

describe("SalesPage : page rendue à la demande", () => {
  it("lit l'adresse du navigateur, sans variante statique", () => {
    window.history.replaceState(null, "", "/sales?page=5&city=Pau");
    const { getByTestId } = render(<SalesPage serverSeeded />);
    expect(getByTestId("page").textContent).toBe("page 5");
    expect(state.searches.at(-1)).toMatchObject({ page: 5, city: "Pau" });
  });
});
