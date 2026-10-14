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
    placement: null,
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

  it("affiche « Publicité · Sponsorisé » sur les profils sponsorisés seulement", async () => {
    renderDirectory([
      profile({
        id: "a",
        displayName: "Maître Sponsorisé",
        isSponsored: true,
        placement: "active",
      }),
      profile({ id: "b", displayName: "Maître Standard" }),
    ]);
    const sponsored = (await screen.findByText("Maître Sponsorisé")).closest("article");
    const standard = screen.getByText("Maître Standard").closest("article");
    expect(sponsored).not.toBeNull();
    expect(standard).not.toBeNull();
    expect(within(sponsored as HTMLElement).getByText("Publicité · Sponsorisé")).toBeTruthy();
    expect(within(standard as HTMLElement).queryByText(/Sponsorisé/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/partenaire/i);
  });

  it("signale une mise en avant encore en essai comme telle, sans la dire payée", async () => {
    renderDirectory([
      profile({ id: "t", displayName: "Maître Essai", isSponsored: true, placement: "trial" }),
    ]);
    const trial = (await screen.findByText("Maître Essai")).closest("article") as HTMLElement;
    expect(
      within(trial).getByText("Publicité · Sponsorisé (période d’essai gratuite)"),
    ).toBeTruthy();
    expect(within(trial).queryByText("Publicité · Sponsorisé")).toBeNull();
    expect(screen.getByText("Mise en avant (essai ou payante)")).toBeTruthy();
    expect(document.body.textContent).not.toContain("rémunèrent Immojudis");
  });

  it("décrit le classement réel des avocats", async () => {
    renderDirectory([profile({ id: "a" })]);
    const heading = await screen.findByRole("heading", {
      name: "Comment sont classés les avocats ?",
    });
    const text = heading.parentElement?.textContent ?? "";
    expect(text).toContain("barreau");
    expect(text).toContain("niveau de priorité attribué par Immojudis");
    expect(text).toContain("ordre alphabétique");
    expect(text).toContain("annuaire officiel du CNB");
  });

  it("n'affiche pas plus de trois domaines d'intervention par avocat", async () => {
    renderDirectory([
      profile({ id: "a", practiceTags: ["un", "deux", "trois", "quatre", "cinq"] }),
    ]);
    const tags = await screen.findByRole("list", { name: "Domaines d'intervention" });
    expect(
      within(tags)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Un", "Deux", "Trois"]);
  });
});
