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
