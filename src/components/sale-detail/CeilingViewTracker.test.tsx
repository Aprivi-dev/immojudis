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
    render(<CeilingViewTracker computed={false} />);
    expect(mocks.track).not.toHaveBeenCalled();
  });

  it("mesure le plafond calculé une fois par chargement de page, sans identifiant", () => {
    const { rerender } = render(<CeilingViewTracker computed={false} />);
    rerender(<CeilingViewTracker computed />);
    rerender(<CeilingViewTracker computed />);
    cleanup();
    render(<CeilingViewTracker computed />);
    expect(mocks.track.mock.calls).toEqual([["ceiling_viewed"]]);
  });
});
