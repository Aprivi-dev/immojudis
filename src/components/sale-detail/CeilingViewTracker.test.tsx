// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/lib/product-events", () => ({ trackProductEvent: mocks.track }));

import { CeilingViewTracker } from "./CeilingViewTracker";

afterEach(() => {
  cleanup();
  mocks.track.mockClear();
});

describe("CeilingViewTracker", () => {
  it("ne mesure rien tant que le plafond n'est pas calculé", () => {
    render(<CeilingViewTracker saleId="sale-a" computed={false} />);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("mesure le plafond calculé une fois par vente dans la page, sans identifiant", () => {
    const { rerender } = render(<CeilingViewTracker saleId="sale-b" computed={false} />);
    rerender(<CeilingViewTracker saleId="sale-b" computed />);
    rerender(<CeilingViewTracker saleId="sale-b" computed />);
    cleanup();
    render(<CeilingViewTracker saleId="sale-b" computed />);
    expect(mocks.track.mock.calls).toEqual([["ceiling_viewed"]]);

    render(<CeilingViewTracker saleId="sale-c" computed />);
    expect(mocks.track).toHaveBeenCalledTimes(2);
  });
});
