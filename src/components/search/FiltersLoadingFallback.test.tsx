// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FiltersLoadingFallback } from "./FiltersLoadingFallback";

afterEach(cleanup);

it("exposes the slow-loading filter state as a focused modal", async () => {
  render(<FiltersLoadingFallback />);

  const dialog = screen.getByRole("dialog", { name: "Filtres avancés" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(screen.getByRole("status", { name: "Chargement des filtres avancés…" })).toBeTruthy();

  await waitFor(() => expect(document.activeElement).toBe(dialog));
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(document.activeElement).toBe(dialog);
});
