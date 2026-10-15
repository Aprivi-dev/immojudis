// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { SearchPagination } from "./SearchPagination";

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
    expect(screen.getByRole("status").textContent).toContain("25–48 / 73 dossiers");
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
    expect(screen.queryByText(/dossiers/)).toBeNull();
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
