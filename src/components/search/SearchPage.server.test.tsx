// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AuctionSale } from "@/lib/types";

const auth = vi.hoisted(() => ({ loading: true, user: null as null | { id: string } }));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: auth.user, loading: auth.loading, session: null, authError: null }),
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/sales",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

import { SearchPage } from "./SearchPage";
import {
  ANONYMOUS_PREVIEW_SCOPE,
  salesSearchCountQueryKey,
  salesSearchQueryKey,
} from "@/lib/search/catalog-placeholder";
import { upcomingWeekScope } from "@/lib/search/sales-week";
import { salesSearchSignature } from "@/lib/search/search-url-state";

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

/** Texte du h1 du HTML, lu par le parseur du navigateur (balises et commentaires de React ignorés). */
function headingText(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  return (doc.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim();
}

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
    const links = new Set(html.match(/href="\/sales\/[0-9a-f-]{36}(?:\?[^"]*)?"/g));
    expect(links.size).toBe(24);
    expect(html.match(/<h1/g)).toHaveLength(1);
    // Le titre en phrase porte déjà le total servi par le serveur.
    expect(headingText(html)).toMatch(/^2\s?276 ventes immobilières aux enchères à venir\.$/);
    expect(html).toMatch(/2\s?276 annonces/);
  });

  it("dit dans le titre du HTML combien de ventes ont lieu cette semaine, quand le serveur l'a compté", () => {
    const client = seededClient();
    const week = upcomingWeekScope({}, "2026-11-06");
    if (week.kind !== "count") throw new Error("semaine attendue");
    client.setQueryData(
      salesSearchCountQueryKey(salesSearchSignature(week.search), ANONYMOUS_PREVIEW_SCOPE),
      41,
    );
    const html = renderToString(
      <QueryClientProvider client={client}>
        <SearchPage search={{}} serverSeeded serverToday="2026-11-06" />
      </QueryClientProvider>,
    );
    expect(headingText(html)).toMatch(
      /^2\s?276 ventes immobilières aux enchères à venir, dont 41 cette semaine\.$/,
    );
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
    expect(html).not.toMatch(/href="\/sales\/[0-9a-f-]{36}(?:\?[^"]*)?"/);
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
    expect(
      new Set(container.innerHTML.match(/href="\/sales\/[0-9a-f-]{36}(?:\?[^"]*)?"/g)).size,
    ).toBe(24);
    expect(headingText(before)).toContain("ventes immobilières aux enchères à venir");
    await act(async () => root.unmount());
    errors.mockRestore();
    container.remove();
  });
});
