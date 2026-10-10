// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// Rendering on the server must never ask for the URL through useSearchParams:
// inside a prerendered page it would replace the whole page by an empty shell.
const mocks = vi.hoisted(() => ({
  useSearchParams: vi.fn(() => {
    throw new Error("BAILOUT_TO_CLIENT_SIDE_RENDERING");
  }),
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
  fetchAccessPlan: vi.fn(() => new Promise(() => undefined)),
}));
vi.mock("@/lib/client-billing", () => ({}));

import { OffersPage } from "./offres";
import { LawyerDirectoryPage } from "./avocats";

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

  it("/avocats renders its heading and the search form from the filters it is given", () => {
    const output = html(<LawyerDirectoryPage search={{ bar: "Bordeaux" }} />);
    expect(output.match(/<h1/g)).toHaveLength(1);
    expect(output).toContain("Avocats en droit immobilier");
    expect(output).toContain('value="Bordeaux"');
    expect(mocks.useSearchParams).not.toHaveBeenCalled();
  });

  it("/avocats keeps the sale the visitor came from", () => {
    const output = html(<LawyerDirectoryPage search={{ saleId: "abc" }} />);
    expect(output).toContain('href="/sales/abc"');
    expect(output).toContain('name="saleId"');
  });
});
