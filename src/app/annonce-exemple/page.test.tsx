import { describe, expect, it, vi } from "vitest";

vi.mock("./example-sale-page", () => ({ ExampleSalePage: () => null }));

import Page, { metadata } from "./page";

describe("/annonce-exemple server page", () => {
  it.each([
    [{ bien: "nantes" }, "Nantes"],
    [{ bien: "toulouse" }, "Toulouse"],
    [{}, "Bordeaux"],
    // The former limitation parameter and unknown values keep the full Bordeaux example.
    [{ bien: "decouverte" }, "Bordeaux"],
    [{ bien: ["nantes", "toulouse"] }, "Bordeaux"],
  ])("picks the example from the URL on the server: %j", async (params, city) => {
    const element = await Page({ searchParams: Promise.resolve(params) });
    expect(element.props.example.sale.city).toBe(city);
  });

  it("computes the dates when the page is generated: the hearing is in the future", async () => {
    const element = await Page({ searchParams: Promise.resolve({}) });
    const hearing = Date.parse(element.props.example.sale.sale_date);
    expect(hearing).toBeGreaterThan(Date.now() + 20 * 86_400_000);
    expect(hearing).toBeLessThan(Date.now() + 22 * 86_400_000);
  });

  it("is indexable, with a title and description of its own", () => {
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates).toEqual({ canonical: "/annonce-exemple" });
    expect(String(metadata.title)).not.toMatch(/immojudis/i);
    expect(String(metadata.description)).toMatch(/^Exemple fictif/);
  });
});
