// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreetViewDialog } from "./StreetViewDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function mockPanorama(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const paris = { lat: 48.8566, lng: 2.3522, address: "Paris" };

describe("StreetViewDialog", () => {
  it("opens Google's street panorama facing the listing, only once the dialog is open", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "test-key");
    const fetchMock = mockPanorama({
      panorama: { status: "ready", pano: "pano-1", heading: 135, distanceM: 18, date: "2024-05" },
    });

    renderWithQuery(<StreetViewDialog target={paris} title="Voir le quartier" />);

    expect(document.querySelector("iframe")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Street View" }));

    const iframe = await screen.findByTitle("Voir le quartier — Paris");
    const src = iframe.getAttribute("src") ?? "";
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/street-view?lat=48.8566&lng=2.3522",
      expect.anything(),
    );
    expect(src).toContain("/maps/embed/v1/streetview");
    expect(src).toContain("pano=pano-1");
    expect(src).toContain("heading=135");

    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("says so when Google has no street imagery nearby", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "test-key");
    mockPanorama({ panorama: { status: "unavailable", reason: "no_google_imagery" } });

    renderWithQuery(<StreetViewDialog target={paris} />);
    fireEvent.click(screen.getByRole("button", { name: "Street View" }));

    expect(await screen.findByText(/ne propose pas de vue de la rue/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
    expect(
      screen
        .getByRole("link", { name: "Voir l’emplacement dans Google Maps" })
        .getAttribute("href"),
    ).toContain("query=48.8566,2.3522");
  });

  it("falls back to the nearest panorama when the lookup fails", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "test-key");
    mockPanorama({ error: "down" }, false);

    renderWithQuery(<StreetViewDialog target={paris} title="Voir le quartier" />);
    fireEvent.click(screen.getByRole("button", { name: "Street View" }));

    // One retry (about a second) before the fallback.
    const iframe = await screen.findByTitle("Voir le quartier — Paris", undefined, {
      timeout: 4_000,
    });
    expect(iframe.getAttribute("src")).toContain("location=48.8566%2C2.3522");
    expect(iframe.getAttribute("src")).not.toContain("pano=");
  });

  it("does not render an action when the public API key is missing", () => {
    renderWithQuery(<StreetViewDialog target={{ lat: 48.8566, lng: 2.3522 }} />);

    expect(screen.queryByRole("button", { name: "Street View" })).toBeNull();
  });

  it("does not render an action when only an address is available", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "test-key");

    renderWithQuery(<StreetViewDialog target={{ address: "Paris" }} />);

    expect(screen.queryByRole("button", { name: "Street View" })).toBeNull();
  });
});
