import { describe, expect, it, vi } from "vitest";

vi.mock("./lawyer-directory-page", () => ({ LawyerDirectoryPage: () => null }));

import Page, * as pageModule from "./page";

const { metadata } = pageModule;

describe("/avocats server page", () => {
  it("is static: it takes no request data, so it is prerendered once for every visitor", () => {
    // `searchParams` (a request-time API) would make the route dynamic: the filters of the URL
    // are read in the browser by the directory instead.
    expect(Page.length).toBe(0);
    expect(Object.keys(pageModule).sort()).toEqual(["default", "metadata"]);
    for (const option of ["dynamic", "revalidate", "fetchCache", "runtime"])
      expect(pageModule).not.toHaveProperty(option);
  });

  it("renders the breadcrumb data, then the directory, without any filter prop", () => {
    const element = Page();
    const directory = element.props.children.find(
      (child: { type?: { name?: string } }) => child.type?.name === "LawyerDirectoryPage",
    );
    expect(directory.props).toEqual({});
  });

  it("keeps the title, the description and the canonical of the indexed page", () => {
    expect(metadata.title).toBe("Annuaire des avocats par barreau");
    expect(metadata.description).toContain("avocat inscrit au barreau compétent");
    expect(metadata.alternates).toEqual({ canonical: "/avocats" });
  });
});
