// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StreetViewDialog } from "./StreetViewDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("StreetViewDialog", () => {
  it("keeps the iframe unloaded until the dialog opens and removes it on close", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "test-key");

    render(
      <StreetViewDialog
        target={{ lat: 48.8566, lng: 2.3522, address: "Paris" }}
        title="Voir le quartier"
      />,
    );

    expect(document.querySelector("iframe")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Street View" }));

    const iframe = screen.getByTitle("Voir le quartier — Paris");
    expect(iframe.getAttribute("src")).toContain("/maps/embed/v1/streetview");
    expect(iframe.getAttribute("src")).toContain("location=48.8566%2C2.3522");

    fireEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("does not render an action when the public API key is missing", () => {
    render(<StreetViewDialog target={{ lat: 48.8566, lng: 2.3522 }} />);

    expect(screen.queryByRole("button", { name: "Street View" })).toBeNull();
  });

  it("does not render an action when only an address is available", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_MAPS_EMBED_API_KEY", "test-key");

    render(<StreetViewDialog target={{ address: "Paris" }} />);

    expect(screen.queryByRole("button", { name: "Street View" })).toBeNull();
  });
});
