// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ props: {} as Record<string, unknown> }));
vi.mock("sonner", () => ({
  Toaster: (props: Record<string, unknown>) => {
    captured.props = props;
    return null;
  },
}));

import { AppToaster } from "./AppToaster";

function mockViewport(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppToaster", () => {
  it("place les notifications en bas au centre sous 640 px", () => {
    mockViewport(true);
    render(<AppToaster />);
    expect(captured.props.position).toBe("bottom-center");
  });

  it("les garde en haut à droite sur grand écran", () => {
    mockViewport(false);
    render(<AppToaster />);
    expect(captured.props.position).toBe("top-right");
  });
});
