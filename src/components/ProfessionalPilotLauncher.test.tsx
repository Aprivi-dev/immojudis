// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("professional pilot entry", () => {
  it.each([
    ["tribunal", "Préparer votre audience", "Dossier d'audience"],
    ["notary", "Préparer votre offre", "Dossier d'offre"],
    ["state", "Préparer votre candidature", "Dossier de candidature"],
  ] as const)("shows a short %s action before opening the dossier", (kind, title, dossierTitle) => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <ProfessionalPilotLauncher
          sale={EXAMPLE_SALE}
          definition={{ ...baseDefinition, kind, title: dossierTitle }}
          publicDemo
        />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: title })).toBeTruthy();
    expect(screen.queryByText("Consignation")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ouvrir le dossier" }));
    expect(screen.getByRole("dialog", { name: dossierTitle })).toBeTruthy();
    expect(screen.getByText("Consignation")).toBeTruthy();
    expect(screen.getByRole("button", { name: "2. Budget" })).toBeTruthy();
  });
});
