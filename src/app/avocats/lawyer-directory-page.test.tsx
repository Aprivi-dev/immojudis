// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LawyerDirectoryProfile, LawyerDirectoryResponse } from "@/lib/lawyer-directory";

const mocks = vi.hoisted(() => ({ fetchLawyerDirectory: vi.fn() }));

vi.mock("@/lib/client-api", () => ({ fetchLawyerDirectory: mocks.fetchLawyerDirectory }));
vi.mock("@/components/LawyerReferralButton", () => ({ LawyerReferralButton: () => null }));

import { LawyerDirectoryPage } from "./lawyer-directory-page";

function profile(overrides: Partial<LawyerDirectoryProfile>): LawyerDirectoryProfile {
  return {
    id: "lawyer-1",
    displayName: "Maître Dupont",
    firmName: null,
    email: null,
    phone: null,
    websiteUrl: null,
    barAssociation: "Bordeaux",
    barNumber: null,
    city: "Bordeaux",
    department: "33",
    address: null,
    profileSummary: null,
    practiceTags: [],
    acceptsRemoteContact: false,
    coverageLabels: [],
    matchingLabel: null,
    isSponsored: false,
    source: "immojudis",
    oathDate: null,
    languages: [],
    ...overrides,
  };
}

function renderDirectory(lawyers: LawyerDirectoryProfile[]) {
  const response: LawyerDirectoryResponse = {
    lawyers,
    sectorLabel: "Bordeaux",
    barAssociation: "Bordeaux",
    isDemo: false,
    officialSource: null,
  };
  mocks.fetchLawyerDirectory.mockResolvedValue(response);
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <LawyerDirectoryPage search={{ bar: "Bordeaux" }} />
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe("annuaire des avocats", () => {
  it("ne laisse pas entendre de spécialisation dans les titres", async () => {
    renderDirectory([profile({ id: "a" })]);
    expect(await screen.findByRole("heading", { name: "Avocats de l'annuaire" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Avocats inscrits au barreau",
    );
    expect(document.body.textContent).not.toMatch(/Spécialistes en droit immobilier/i);
  });

  it("affiche « Mise en avant payante » sur les profils sponsorisés seulement", async () => {
    renderDirectory([
      profile({ id: "a", displayName: "Maître Sponsorisé", isSponsored: true }),
      profile({ id: "b", displayName: "Maître Standard" }),
    ]);
    const sponsored = (await screen.findByText("Maître Sponsorisé")).closest("article");
    const standard = screen.getByText("Maître Standard").closest("article");
    expect(sponsored).not.toBeNull();
    expect(standard).not.toBeNull();
    expect(within(sponsored as HTMLElement).getByText("Mise en avant payante")).toBeTruthy();
    expect(within(standard as HTMLElement).queryByText("Mise en avant payante")).toBeNull();
  });
});
