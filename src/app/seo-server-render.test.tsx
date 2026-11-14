// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Rendering on the server must never ask for the URL through useSearchParams outside a Suspense
// boundary: inside a prerendered page it would replace the whole page by an empty shell. Where it
// is read (under Suspense), the prerender gives up on that part only: the throw below stands for it.
const mocks = vi.hoisted(() => ({
  useSearchParams: vi.fn(() => {
    throw new Error("BAILOUT_TO_CLIENT_SIDE_RENDERING");
  }),
  loadSaleLanding: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  redirect: vi.fn(),
  usePathname: () => "/",
  useParams: () => ({}),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() }),
  useSearchParams: mocks.useSearchParams,
}));
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, session: null, profile: null, loading: true, authError: null }),
}));
vi.mock("@/lib/client-api", () => ({
  fetchLawyerDirectory: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/client-billing", () => ({
  fetchAccessPlan: vi.fn(() => new Promise(() => undefined)),
  fetchBillingOffer: vi.fn(),
}));
vi.mock("@/lib/sale-landing-pages.server", () => ({
  loadSaleLandingForPage: mocks.loadSaleLanding,
}));

import { OffersPage } from "./offres/offers-page";
import { LawyerDirectoryPage } from "./avocats/lawyer-directory-page";
import HousePage from "./maison-aux-encheres/page";
import ApartmentPage from "./appartement-aux-encheres/page";
import NotaryPage from "./encheres-notariales/page";
import StatePage from "./ventes-immobilieres-etat/page";

function html(node: React.ReactNode) {
  return renderToString(
    <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>,
  );
}

describe("pages that crawlers must read", () => {
  it("/accompagnement renders its heading without reading the URL", () => {
    const output = html(<OffersPage />);
    expect(output.match(/<h1/g)).toHaveLength(1);
    expect(output).toContain("Préparez votre limite avant l’enchère");
    expect(mocks.useSearchParams).not.toHaveBeenCalled();
  });

  it("/avocats prerenders its heading, explanation and search form, whatever the URL says", () => {
    const output = html(<LawyerDirectoryPage />);
    expect(output.match(/<h1/g)).toHaveLength(1);
    expect(output).toContain("Avocats inscrits au barreau");
    expect(output).toContain("Comment sont classés les avocats ?");
    expect(output).not.toContain("Spécialistes en droit immobilier");
    // The form and the back link are those of the page without filters.
    expect(output).toContain('action="/avocats"');
    expect(output).toContain('name="bar"');
    expect(output).not.toContain('name="saleId"');
    expect(output).toContain('href="/sales"');
    // The filters were asked for inside the Suspense boundary, which the prerender abandons for
    // the browser: the HTML carries the fallback (the same page, with the loading skeleton).
    expect(mocks.useSearchParams).toHaveBeenCalled();
    expect(output).toContain("Chargement de l&#x27;annuaire");
  });

  it.each([
    ["/maison-aux-encheres", HousePage, "maison en vente aux enchères ou sur offres, à venir"],
    [
      "/appartement-aux-encheres",
      ApartmentPage,
      "appartement en vente aux enchères ou sur offres, à venir",
    ],
    ["/encheres-notariales", NotaryPage, "Enchères et ventes interactives des notaires :"],
    ["/ventes-immobilieres-etat", StatePage, "Ventes immobilières de l’État : "],
  ] as const)(
    "%s renders its heading, its sales and its guide on the server",
    async (_path, Page, heading) => {
      mocks.useSearchParams.mockClear();
      mocks.loadSaleLanding.mockResolvedValue({
        generatedAt: "2026-11-14T08:00:00.000Z",
        upcomingCount: 1,
        sales: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            department: "33",
            city: "Bordeaux",
            propertyType: "house",
            saleDate: "2099-11-20T13:00:00Z",
            startingPriceEur: 80_000,
            surfaceM2: 90,
            venueType: "tribunal",
            status: "scheduled",
          },
        ],
      });
      const output = html(await Page());
      expect(output.match(/<h1/g)).toHaveLength(1);
      expect(output).toContain(heading);
      expect(output).toContain("Les prochaines ventes");
      expect(output).toContain("Bordeaux (33)");
      expect(output).toContain('href="/sales/00000000-0000-4000-8000-000000000001"');
      expect(output).toContain("Pour comprendre");
      // Une page serveur : rien n'attend l'adresse de la page.
      expect(mocks.useSearchParams).not.toHaveBeenCalled();
    },
  );
});
