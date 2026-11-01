// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MapPanelProps } from "./MapPanel";

const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("./preload-map", () => ({ loadMapPanelModule: loader.load }));

import { LazyMapPanel } from "./LazyMapPanel";

const props = { onShowList: vi.fn() } as unknown as MapPanelProps;

function loaded() {
  return Promise.resolve({ MapPanel: () => <div data-testid="map-panel" /> });
}

beforeEach(() => {
  loader.load.mockReset();
  // React journalise l'erreur attrapée par la frontière : attendue ici.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(cleanup);

describe("LazyMapPanel : le module de la carte ne se télécharge pas", () => {
  it("montre le squelette, puis la carte une fois le module arrivé", async () => {
    loader.load.mockImplementation(loaded);
    render(<LazyMapPanel {...props} />);
    expect(screen.getByText("Chargement de la carte")).toBeTruthy();
    expect(await screen.findByTestId("map-panel")).toBeTruthy();
  });

  it("garde la page debout : message, « Réessayer » et « Voir la liste » à la place de la carte", async () => {
    loader.load.mockRejectedValue(new Error("Loading chunk failed"));
    render(<LazyMapPanel {...props} />);

    expect(await screen.findByRole("heading", { name: "Carte indisponible" })).toBeTruthy();
    expect(screen.getByText(/Les annonces restent accessibles dans la liste/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Réessayer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Voir la liste" }));
    expect((props.onShowList as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("« Réessayer » télécharge de nouveau le module et affiche la carte quand le réseau est revenu", async () => {
    loader.load.mockRejectedValueOnce(new Error("Loading chunk failed"));
    loader.load.mockImplementation(loaded);
    render(<LazyMapPanel {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Réessayer" }));
    expect(await screen.findByTestId("map-panel")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Carte indisponible" })).toBeNull();
    expect(loader.load).toHaveBeenCalledTimes(2);
  });

  it("n'insiste pas indéfiniment : après trois échecs, plus de « Réessayer »", async () => {
    loader.load.mockRejectedValue(new Error("Loading chunk failed"));
    render(<LazyMapPanel {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "Réessayer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Réessayer" }));
    await screen.findByRole("heading", { name: "Carte indisponible" });
    expect(await screen.findByRole("link", { name: "Voir la liste" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Réessayer" })).toBeNull();
    expect(loader.load).toHaveBeenCalledTimes(3);
  });
});
