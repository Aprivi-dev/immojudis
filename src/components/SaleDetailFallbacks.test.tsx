// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SaleDetailSkeleton } from "./SaleDetailFallbacks";

afterEach(cleanup);

describe("SaleDetailSkeleton", () => {
  it("is announced as a loading status and keeps the main landmark of the page", () => {
    render(<SaleDetailSkeleton />);

    const status = screen.getByRole("status", { name: "Chargement de la fiche" });
    expect(status).toBeTruthy();
    // The status role sits inside <main>: it does not replace the landmark.
    expect(screen.getByRole("main").contains(status)).toBe(true);
  });
});
