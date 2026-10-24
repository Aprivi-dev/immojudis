import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/form", () => ({
  default: ({ children, ...props }: { children: React.ReactNode }) => (
    <form {...props}>{children}</form>
  ),
}));

import { HomeClosing } from "./HomeClosing";

describe("HomeClosing", () => {
  it("ends the home page on the same search as the hero", () => {
    const markup = renderToStaticMarkup(<HomeClosing />);
    const form = /<form\b[^>]*>/.exec(markup)?.[0] ?? "";
    expect(form).toContain('action="/sales"');
    expect(form).toContain('role="search"');
    expect(markup).toContain('name="q"');
    expect(markup).toContain('<label class="sr-only" for="home-search-end">');
    expect(markup).toContain("Explorer les ventes");
  });
});
