import { describe, expect, it, vi } from "vitest";

vi.mock("@/routes/avocats", () => ({ LawyerDirectoryPage: () => null }));

import Page, { metadata } from "./page";

describe("/avocats server page", () => {
  it("passes the URL filters to the directory as props", async () => {
    const element = await Page({
      searchParams: Promise.resolve({ bar: "Bordeaux", saleId: ["x", "abc"], other: "ignored" }),
    });
    expect(element.props.search).toEqual({
      bar: "Bordeaux",
      saleId: "abc",
      city: undefined,
      department: undefined,
    });
  });

  it("has an accented title without the site name", () => {
    expect(metadata.title).toBe("Annuaire des avocats en droit immobilier");
    expect(metadata.alternates).toEqual({ canonical: "/avocats" });
  });
});
