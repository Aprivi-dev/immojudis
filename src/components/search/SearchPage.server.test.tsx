// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

const auth = vi.hoisted(() => ({ loading: true, user: null as null | { id: string } }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: auth.user, loading: auth.loading, session: null, authError: null }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/router-compat", () => ({
  Link: ({
    to,
    params,
    children,
    ...props
  }: Record<string, unknown> & { children?: ReactNode }) => (
    <a
      href={String(to).replace("$id", String((params as { id?: string } | undefined)?.id ?? ""))}
      {...(props as object)}
    >
      {children}
    </a>
  ),
  useNavigate: () => () => undefined,
  useLocation: () => ({ pathname: "/sales", search: "", href: "/sales" }),
}));

import { SearchPage } from "./SearchPage";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";

const sales = Array.from({ length: 24 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  starting_price_eur: 50_000 + index * 1000,
  sale_venue_type: "tribunal",
  sale_verification_status: "verified",
  city: "Romainville",
  department: "93",
  property_type: "apartment",
  sale_date: "2099-10-20T09:00:00Z",
  app_surface_m2: 50,
  media: [],
})) as unknown as AuctionSale[];

function seededClient() {
  const client = new QueryClient();
  client.setQueryData(salesSearchQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), sales);
  client.setQueryData(salesSearchCountQueryKey("[]", ANONYMOUS_PREVIEW_SCOPE), 2276);
  return client;
}

describe("SearchPage rendered on the server", () => {
  it("contains the listings and a link to every sale in the HTML itself", () => {
    auth.loading = true;
    const html = renderToString(
      <QueryClientProvider client={seededClient()}>
        <SearchPage search={{}} serverSeeded />
      </QueryClientProvider>,
    );
    const links = new Set(html.match(/href="\/sales\/[0-9a-f-]{36}"/g));
    expect(links.size).toBe(24);
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain("Ventes immobilières aux enchères");
    expect(html).toMatch(/2\s?276 annonces/);
  });

  it("does not shift the layout when the media query resolves", () => {
    const html = renderToString(
      <QueryClientProvider client={seededClient()}>
        <SearchPage search={{}} serverSeeded />
      </QueryClientProvider>,
    );
    // Columns are decided by CSS breakpoints, not by a JavaScript media query.
    expect(html).toMatch(/grid-cols-1 lg:grid-cols-\[/);
    expect(html).toContain('class="relative hidden');
  });

  it("falls back to the skeleton when the server could not seed the page", () => {
    auth.loading = true;
    const html = renderToString(
      <QueryClientProvider client={new QueryClient()}>
        <SearchPage search={{}} />
      </QueryClientProvider>,
    );
    expect(html).not.toMatch(/href="\/sales\/[0-9a-f-]{36}"/);
  });

  it("hydrates the server HTML without a mismatch", async () => {
    auth.loading = true;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        matches: false,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }),
    });
    const tree = (client: QueryClient) => (
      <QueryClientProvider client={client}>
        <SearchPage search={{}} serverSeeded />
      </QueryClientProvider>
    );
    const container = document.createElement("div");
    container.innerHTML = renderToString(tree(seededClient()));
    document.body.append(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const before = container.innerHTML;

    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(container, tree(seededClient()));
    });

    const hydrationErrors = errors.mock.calls.filter((call) =>
      /hydrat|did not match|didn't match/i.test(String(call[0])),
    );
    expect(hydrationErrors).toEqual([]);
    // Same listings before and after: hydration reuses the server rows, no skeleton in between.
    expect(new Set(container.innerHTML.match(/href="\/sales\/[0-9a-f-]{36}"/g)).size).toBe(24);
    expect(before).toContain("Ventes immobilières aux enchères");
    await act(async () => root.unmount());
    errors.mockRestore();
    container.remove();
  });
});
