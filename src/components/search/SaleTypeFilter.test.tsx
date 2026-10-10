// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SaleTypeFilter as SaleTypeValue } from "@/lib/sale-types";
import {
  draftToSearch,
  searchToDraft,
  emptySearchDraft,
  buildAlertName,
} from "./search-page-state";

import { SaleTypeFilter } from "./SaleTypeFilter";

function FilterHarness() {
  const [value, setValue] = useState<SaleTypeValue | "">("");
  return <SaleTypeFilter value={value} onChange={setValue} />;
}

describe("sale type search controls", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
  });
  it("offers the notarial and State sales by default", () => {
    render(<FilterHarness />);
    expect(screen.getByRole("button", { name: "Chez le notaire" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Domaniales" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Au tribunal" })).toBeTruthy();
  });
  it("hides them only when the flag is explicitly set to false", () => {
    vi.stubEnv("NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED", "false");
    render(<FilterHarness />);
    expect(screen.queryByRole("button", { name: "Chez le notaire" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Domaniales" })).toBeNull();
  });
  it("exposes an accessible selection and a working comparison anchor", () => {
    vi.stubEnv("NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED", "true");
    render(<FilterHarness />);
    expect(screen.getByRole("group", { name: "Type de vente" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chez le notaire" }));
    expect(
      screen.getByRole("button", { name: "Chez le notaire" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Toutes" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Toutes" }));
    expect(screen.getByRole("button", { name: "Toutes" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.queryByRole("button", { name: "En ligne" })).toBeNull();
    expect(screen.getByRole("link", { name: "Quelle différence ?" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#differences",
    );
  });
  it("preserves the family when editing other filters and includes it in the alert name", () => {
    const search = { saleType: "notary" as const, city: "Bordeaux", page: 3 };
    expect(draftToSearch(searchToDraft(search), search)).toMatchObject({
      saleType: "notary",
      city: "Bordeaux",
    });
    expect(draftToSearch(emptySearchDraft(), search).saleType).toBeUndefined();
    expect(buildAlertName(search)).toContain("Chez le notaire");
  });
});
