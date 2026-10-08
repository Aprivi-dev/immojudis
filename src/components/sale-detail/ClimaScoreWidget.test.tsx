// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClimaScoreWidget } from "./ClimaScoreWidget";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("ClimaScore widget", () => {
  it("loads only on demand and isolates the provider while preserving attribution", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ commune: { code: "33063", name: "Bordeaux" } }));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <ClimaScoreWidget city="Bordeaux" postalCode="33000" />
      </QueryClientProvider>,
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(container.querySelector("iframe")).toBeNull();
    const details = container.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    await waitFor(() => expect(screen.getByTitle("ClimaScore — commune de Bordeaux")).toBeTruthy());
    const iframe = container.querySelector("iframe")!;
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.srcdoc).toContain("climascore-33063.js");
    expect(screen.getByRole("link", { name: /Source : ClimaScore/ }).getAttribute("href")).toBe(
      "https://climascore.fr/risques/33063",
    );
  });
  it("does not display a score when the location is missing", () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <ClimaScoreWidget city={null} postalCode="33000" />
      </QueryClientProvider>,
    );
    expect(container.innerHTML).toBe("");
  });
});
