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

import { SaleTypeFilter, SaleTypeSelect } from "./SaleTypeFilter";

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
  it("keeps the comparison link in the compact version, and every control at 44 px", () => {
    render(<SaleTypeFilter compact value="" onChange={() => undefined} />);
    expect(screen.getByRole("link", { name: "Quelle différence ?" }).getAttribute("href")).toBe(
      "/ventes-immobilieres-judiciaires#differences",
    );
    const controls = [
      ...screen.getAllByRole("button"),
      screen.getByRole("link", { name: "Quelle différence ?" }),
    ];
    expect(controls.length).toBeGreaterThan(2);
    for (const control of controls) {
      expect(control.className, control.textContent ?? "").toContain("min-h-11");
    }
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

describe("SaleTypeSelect", () => {
  afterEach(cleanup);

  it("propose « Toutes les ventes » et les types, et prévient du choix", () => {
    const onChange = vi.fn();
    render(<SaleTypeSelect value="" onChange={onChange} />);
    const select = screen.getByRole("combobox", { name: "Type de vente" }) as HTMLSelectElement;
    expect([...select.options].map((option) => [option.value, option.textContent])).toEqual([
      ["", "Toutes les ventes"],
      ["tribunal", "Au tribunal"],
      ["notary", "Chez le notaire"],
      ["state", "Domaniales"],
      ["unknown", "À préciser"],
    ]);
    fireEvent.change(select, { target: { value: "state" } });
    expect(onChange).toHaveBeenCalledWith("state");
    fireEvent.change(select, { target: { value: "" } });
    expect(onChange).toHaveBeenLastCalledWith("");
  });

  it("reflète la valeur choisie et cache les types pilotes quand ils sont désactivés", () => {
    vi.stubEnv("NEXT_PUBLIC_NOTARY_STATE_PILOTS_ENABLED", "false");
    render(<SaleTypeSelect value="tribunal" onChange={() => undefined} />);
    const select = screen.getByRole("combobox", { name: "Type de vente" }) as HTMLSelectElement;
    expect(select.value).toBe("tribunal");
    expect([...select.options].map((option) => option.value)).not.toContain("notary");
    vi.unstubAllEnvs();
  });
});
