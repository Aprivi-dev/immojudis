// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorState } from "./SearchFilters";
import { ResultsSummary } from "./SearchHeader";

afterEach(cleanup);

it("announces a catalogue failure, hides technical details and offers a retry", () => {
  const onRetry = vi.fn();
  render(
    <ErrorState
      error={Object.assign(new Error("canceling statement due to statement timeout"), {
        code: "57014",
      })}
      onRetry={onRetry}
    />,
  );

  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Le catalogue ne répond pas pour le moment.");
  expect(alert.textContent).toContain("trop de temps à répondre");
  expect(alert.textContent).not.toMatch(/statement|57014/i);

  fireEvent.click(screen.getByRole("button", { name: "Réessayer" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

it("never reports zero listings when the search failed", () => {
  const props = {
    search: {},
    displayCount: 0,
    hasLocalFilters: false,
    isLoading: false,
    geocoding: false,
  };
  const { rerender } = render(<ResultsSummary {...props} hasError />);
  expect(screen.getByText(/Catalogue momentanément indisponible/)).toBeTruthy();
  expect(screen.queryByText(/0 annonce/)).toBeNull();

  rerender(<ResultsSummary {...props} />);
  expect(screen.getByText(/0 annonce/)).toBeTruthy();
});
