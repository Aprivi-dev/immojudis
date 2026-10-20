// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { SALES_PAGINATION_ID, SearchPagination, visiblePages } from "./SearchPagination";

describe("visiblePages", () => {
  it("liste toutes les pages quand il y en a peu", () => {
    expect(visiblePages(1, 1)).toEqual([1]);
    expect(visiblePages(2, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(visiblePages(1, 4)).toEqual([1, 2, 3, 4]);
  });

  it("garde 1, 2, 3, la dernière, la page courante et ses voisines, avec des trous", () => {
    expect(visiblePages(1, 69)).toEqual([1, 2, 3, "gap", 69]);
    expect(visiblePages(30, 69)).toEqual([1, 2, 3, "gap", 29, 30, 31, "gap", 69]);
    expect(visiblePages(69, 69)).toEqual([1, 2, 3, "gap", 68, 69]);
    expect(visiblePages(5, 69)).toEqual([1, 2, 3, 4, 5, 6, "gap", 69]);
  });

  it("comble un trou d'une seule page plutôt que d'y mettre « … »", () => {
    expect(visiblePages(4, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(visiblePages(1, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("ne sort jamais de 1 à la dernière page", () => {
    for (const [page, total] of [
      [1, 2],
      [2, 2],
      [7, 8],
    ] as const) {
      for (const item of visiblePages(page, total)) {
        if (item !== "gap") {
          expect(item).toBeGreaterThanOrEqual(1);
          expect(item).toBeLessThanOrEqual(total);
        }
      }
    }
  });
});

describe("SearchPagination : liens numérotés", () => {
  afterEach(cleanup);

  const hrefFor = (page: number) =>
    page === 1 ? "/sales?city=Pau" : `/sales?city=Pau&page=${page}`;
  const renderNumbered = (props: { page?: number; totalCount?: number } = {}) => {
    const onGoToPage = vi.fn();
    render(
      <SearchPagination
        hasMore
        hasPrevious
        isFetching={false}
        loadedCount={24}
        totalCount={props.totalCount ?? 1646}
        mapListFollowsViewport={false}
        page={props.page ?? 2}
        pageSize={24}
        onNext={() => undefined}
        onPrevious={() => undefined}
        pageHref={hrefFor}
        onGoToPage={onGoToPage}
      />,
    );
    return { onGoToPage };
  };

  it("rend de vrais liens <a href> pour 1, 2, 3, …, la dernière page", () => {
    renderNumbered({ page: 1, totalCount: 1646 });
    const list = screen.getByRole("list");
    const links = Array.from(list.querySelectorAll("a"));
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/sales?city=Pau&page=2",
      "/sales?city=Pau&page=3",
      "/sales?city=Pau&page=69",
    ]);
    // 1 646 annonces à 24 par page : 69 pages.
    expect(screen.getByRole("link", { name: "Page 69" }).textContent).toBe("69");
    // La page courante n'est pas un lien : elle est marquée comme telle.
    const current = list.querySelector("[aria-current='page']");
    expect(current?.tagName).toBe("SPAN");
    // Pas d'aria-label sur le span : le contexte est du texte masqué autour du numéro.
    expect(current?.hasAttribute("aria-label")).toBe(false);
    expect(current?.textContent).toBe("Page 1, page actuelle");
    expect(current?.querySelectorAll(".sr-only")).toHaveLength(2);
    expect(list.textContent).toContain("…");
  });

  it("la page courante garde un fond marine : la liste de classes des autres contrôles ne s'y mêle pas", () => {
    renderNumbered({ page: 1, totalCount: 1646 });
    const current = screen.getByRole("list").querySelector("[aria-current='page']");
    const classes = (current?.getAttribute("class") ?? "").split(/\s+/);
    expect(classes).toContain("bg-brand-navy");
    expect(classes).toContain("text-white");
    // `bg-white` l'emportait sur `bg-brand-navy` : le numéro blanc était invisible.
    expect(classes).not.toContain("bg-white");
    expect(classes).not.toContain("text-brand-navy");
  });

  it("garde l'action du navigateur sur un clic simple et laisse le lien aux touches de modification", () => {
    const { onGoToPage } = renderNumbered({ page: 1 });
    const three = screen.getByRole("link", { name: "Page 3" });
    expect(fireEvent.click(three)).toBe(false);
    expect(onGoToPage).toHaveBeenCalledWith(3);
    onGoToPage.mockClear();
    expect(fireEvent.click(three, { ctrlKey: true })).toBe(true);
    expect(onGoToPage).not.toHaveBeenCalled();
  });

  it("ne propose pas de numéros au-delà de la dernière page que la recherche sait servir", () => {
    renderNumbered({ page: 1, totalCount: 5_000_000 });
    // 10 000 / 24 → 417 pages au plus.
    expect(screen.getByRole("link", { name: "Page 417" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Page 418" })).toBeNull();
  });

  it("n'ajoute aucune liste quand tout tient sur une page ou sans adresse de page", () => {
    const { unmount } = render(
      <SearchPagination
        hasMore={false}
        hasPrevious={false}
        isFetching={false}
        loadedCount={10}
        totalCount={10}
        mapListFollowsViewport={false}
        page={1}
        pageSize={24}
        onNext={() => undefined}
        onPrevious={() => undefined}
        pageHref={hrefFor}
        onGoToPage={() => undefined}
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
    unmount();
    render(
      <SearchPagination
        hasMore
        hasPrevious={false}
        isFetching={false}
        loadedCount={24}
        totalCount={100}
        mapListFollowsViewport={false}
        page={1}
        pageSize={24}
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("donne à la pagination l'identifiant du lien d'évitement et une taille tactile de 44 px", () => {
    renderNumbered({ page: 2 });
    const nav = screen.getByRole("navigation", { name: "Pagination des ventes" });
    expect(nav.id).toBe(SALES_PAGINATION_ID);
    expect(nav.getAttribute("tabindex")).toBe("-1");
    for (const link of screen.getAllByRole("link")) expect(link.className).toContain("h-11");
  });

  it("n'a aucune violation d'accessibilité détectable", async () => {
    renderNumbered({ page: 30 });
    const results = await axe(screen.getByRole("navigation"));
    expect(results.violations).toEqual([]);
  });
});

describe("SearchPagination : page hors bornes", () => {
  afterEach(cleanup);

  const outOfRange = (props: { firstHref?: string; outOfRange?: boolean } = {}) =>
    render(
      <SearchPagination
        hasMore={false}
        hasPrevious
        isFetching={false}
        loadedCount={0}
        totalCount={undefined}
        mapListFollowsViewport={false}
        page={999}
        pageSize={24}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onFirstPage={() => undefined}
        {...props}
      />,
    );

  it("dit que la page n'existe pas et renvoie à la page 1 par un vrai lien", () => {
    outOfRange({ firstHref: "/sales?city=Pau", outOfRange: true });
    expect(screen.getByRole("status").textContent).toBe(
      "Cette page n’existe pas pour cette recherche",
    );
    const link = screen.getByRole("link", { name: "Revenir à la page 1" });
    expect(link.getAttribute("href")).toBe("/sales?city=Pau");
  });

  it("reste un bouton sans adresse de la page 1", () => {
    outOfRange({ outOfRange: true });
    expect(screen.getByRole("button", { name: "Revenir à la page 1" })).toBeTruthy();
  });
});

describe("SearchPagination", () => {
  afterEach(cleanup);

  it("announces the result range and invokes navigation actions", () => {
    const onNext = vi.fn();
    const onPrevious = vi.fn();
    render(
      <SearchPagination
        hasMore
        hasPrevious
        isFetching={false}
        loadedCount={24}
        totalCount={73}
        mapListFollowsViewport={false}
        page={2}
        pageSize={24}
        onNext={onNext}
        onPrevious={onPrevious}
      />,
    );

    expect(screen.getByRole("navigation", { name: "Pagination des ventes" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("25–48 / 73 ventes");
    fireEvent.click(screen.getByRole("button", { name: "Page précédente" }));
    fireEvent.click(screen.getByRole("button", { name: "Page suivante" }));
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  describe("with page addresses", () => {
    const renderLinks = (props: { isFetching?: boolean } = {}) => {
      const onNext = vi.fn();
      const onPrevious = vi.fn();
      render(
        <SearchPagination
          hasMore
          hasPrevious
          isFetching={props.isFetching ?? false}
          loadedCount={24}
          totalCount={73}
          mapListFollowsViewport={false}
          page={2}
          pageSize={24}
          onNext={onNext}
          onPrevious={onPrevious}
          nextHref="/sales?city=Pau&page=3"
          previousHref="/sales?city=Pau"
        />,
      );
      return { onNext, onPrevious };
    };

    it("renders real links to the neighbouring pages", () => {
      renderLinks();
      const next = screen.getByRole("link", { name: "Page suivante" });
      const previous = screen.getByRole("link", { name: "Page précédente" });
      expect(next.getAttribute("href")).toBe("/sales?city=Pau&page=3");
      expect(next.getAttribute("rel")).toBe("next");
      expect(previous.getAttribute("href")).toBe("/sales?city=Pau");
      expect(previous.getAttribute("rel")).toBe("prev");
      expect(screen.queryByRole("button", { name: "Page suivante" })).toBeNull();
    });

    it("keeps the client behaviour on a plain click", () => {
      const { onNext, onPrevious } = renderLinks();
      const next = screen.getByRole("link", { name: "Page suivante" });
      // fireEvent returns false when the default action (following the link) was prevented.
      expect(fireEvent.click(next)).toBe(false);
      expect(fireEvent.click(screen.getByRole("link", { name: "Page précédente" }))).toBe(false);
      expect(onNext).toHaveBeenCalledOnce();
      expect(onPrevious).toHaveBeenCalledOnce();
    });

    it("lets the browser open the link with a modifier key", () => {
      const { onNext } = renderLinks();
      const next = screen.getByRole("link", { name: "Page suivante" });
      expect(fireEvent.click(next, { ctrlKey: true })).toBe(true);
      expect(fireEvent.click(next, { metaKey: true })).toBe(true);
      expect(onNext).not.toHaveBeenCalled();
    });

    it("does nothing while the list is loading", () => {
      const { onNext, onPrevious } = renderLinks({ isFetching: true });
      const loading = screen.getByRole("link", { name: "Chargement..." });
      expect(loading.getAttribute("aria-disabled")).toBe("true");
      expect(fireEvent.click(loading)).toBe(false);
      fireEvent.click(screen.getByRole("link", { name: "Page précédente" }));
      expect(onNext).not.toHaveBeenCalled();
      expect(onPrevious).not.toHaveBeenCalled();
    });
  });

  it("says so and offers page 1 when the page is past the last one", () => {
    const onFirstPage = vi.fn();
    render(
      <SearchPagination
        hasMore={false}
        hasPrevious
        isFetching={false}
        loadedCount={0}
        totalCount={40}
        mapListFollowsViewport={false}
        page={5}
        pageSize={24}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onFirstPage={onFirstPage}
      />,
    );

    expect(screen.getByRole("status").textContent).toBe("Aucun résultat sur cette page");
    expect(screen.queryByText(/ventes/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revenir à la page 1" }));
    expect(onFirstPage).toHaveBeenCalledOnce();
  });

  it("does not claim the page is empty while it is still loading", () => {
    render(
      <SearchPagination
        hasMore={false}
        hasPrevious
        isFetching
        loadedCount={0}
        totalCount={40}
        mapListFollowsViewport={false}
        page={2}
        pageSize={24}
        onNext={() => undefined}
        onPrevious={() => undefined}
        onFirstPage={() => undefined}
      />,
    );
    expect(screen.queryByText("Aucun résultat sur cette page")).toBeNull();
  });

  it("disables navigation while loading and has no detectable a11y violation", async () => {
    const { container } = render(
      <SearchPagination
        hasMore
        hasPrevious
        isFetching
        loadedCount={12}
        totalCount={30}
        mapListFollowsViewport={false}
        page={2}
        pageSize={12}
        onNext={() => undefined}
        onPrevious={() => undefined}
      />,
    );

    expect(
      (screen.getByRole("button", { name: "Page précédente" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "Chargement..." }) as HTMLButtonElement).disabled,
    ).toBe(true);
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
