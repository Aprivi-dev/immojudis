// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(state.search),
}));
vi.mock("@/components/SectorAlertForm", () => ({
  SectorAlertForm: ({ criteria }: { criteria: Record<string, string> }) => (
    <div data-testid="form">{JSON.stringify(criteria)}</div>
  ),
}));

import { CreateAlertPage } from "./CreateAlertPage";

beforeEach(() => {
  state.search = "";
});
afterEach(cleanup);

describe("CreateAlertPage", () => {
  it("retrouve les critères du visiteur et n'écrit rien en arrivant", () => {
    state.search = "department=33&maxPrice=150000";
    render(<CreateAlertPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Créer une alerte" })).toBeTruthy();
    expect(JSON.parse(screen.getByTestId("form").textContent!)).toEqual({
      department: "33",
      maxPrice: "150000",
    });
  });

  it("renvoie vers le catalogue quand l'adresse n'a aucun critère public", () => {
    state.search = "query=texte+libre&minYield=8";
    render(<CreateAlertPage />);
    expect(screen.queryByTestId("form")).toBeNull();
    expect(screen.getByRole("link", { name: "Voir les ventes" }).getAttribute("href")).toBe(
      "/sales",
    );
  });
});
