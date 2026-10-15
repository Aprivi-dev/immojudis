import { describe, expect, it, vi } from "vitest";

vi.mock("./lawyer-directory-page", () => ({ LawyerDirectoryPage: () => null }));

import Page, { metadata } from "./page";

describe("/avocats server page", () => {
  it("passes the URL filters to the directory as props", async () => {
    const element = await Page({
      searchParams: Promise.resolve({ bar: "Bordeaux", saleId: ["x", "abc"], other: "ignored" }),
    });
    // The page is a fragment: the breadcrumb data, then the directory.
    const directory = element.props.children.find(
      (child: { props?: { search?: unknown } }) => child.props?.search !== undefined,
    );
    expect(directory.props.search).toEqual({
      bar: "Bordeaux",
      saleId: "abc",
      city: undefined,
      department: undefined,
    });
  });

  it("has an accented title without the site name", () => {
    expect(metadata.title).toBe("Annuaire des avocats par barreau");
    expect(metadata.alternates).toEqual({ canonical: "/avocats" });
  });
});
