// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXAMPLE_SALE } from "@/lib/example-sale";
import type { PilotDefinition } from "@/lib/professional-pilots";
import { ProfessionalPilotLauncher } from "./ProfessionalPilotLauncher";

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: null, loading: false }),
}));

const baseDefinition: PilotDefinition = {
  kind: "notary",
  title: "Bureau d'offre notariale",
  description: "Préparer une offre",
  priceLabel: "Offre envisagée",
  packetLabel: "Fiche d'offre",
  counterpartyLabel: "Étude notariale",
  counterparty: null,
  facts: [{ label: "Consignation", value: null }],
  milestones: [],
  checks: [],
};

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("professional pilot dialog", () => {
  it.each([
    ["tribunal", "Dossier d'audience"],
    ["notary", "Dossier d'offre"],
    ["state", "Dossier de candidature"],
  ] as const)("opens the %s dossier only when asked to", async (kind, dossierTitle) => {
    const client = new QueryClient();
    const props = {
      sale: EXAMPLE_SALE,
      definition: { ...baseDefinition, kind, title: dossierTitle },
      publicDemo: true,
      onOpenChange: () => undefined,
    };
    const view = render(
      <QueryClientProvider client={client}>
        <ProfessionalPilotLauncher {...props} open={false} />
      </QueryClientProvider>,
    );

    // Plus de bouton propre : « Mon dossier » est l'unique porte (voir SaleFileCard).
    expect(screen.queryByRole("button", { name: "Ouvrir le dossier" })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();

    view.rerender(
      <QueryClientProvider client={client}>
        <ProfessionalPilotLauncher {...props} open />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("dialog", { name: dossierTitle })).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("Consignation")).toBeTruthy();
      expect(screen.getByRole("button", { name: "2. Budget" })).toBeTruthy();
    });
  });
});
