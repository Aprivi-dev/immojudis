// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  idle: [] as Array<() => void>,
}));
vi.mock("@/lib/when-idle", () => ({
  whenIdle: (callback: () => void) => {
    captured.idle.push(callback);
    return () => {};
  },
}));
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

async function renderAfterIdle() {
  const view = render(<AppToaster />);
  await act(async () => captured.idle.splice(0).forEach((callback) => callback()));
  return view;
}

afterEach(() => {
  captured.props = {};
  captured.idle = [];
  cleanup();
  vi.unstubAllGlobals();
});

describe("AppToaster", () => {
  it("place les notifications en bas au centre sous 640 px", async () => {
    mockViewport(true);
    await renderAfterIdle();
    await waitFor(() => expect(captured.props.position).toBe("bottom-center"));
  });

  it("les garde en haut à droite sur grand écran", async () => {
    mockViewport(false);
    await renderAfterIdle();
    await waitFor(() => expect(captured.props.position).toBe("top-right"));
  });

  it("ne charge Sonner qu'une fois le navigateur inactif", async () => {
    mockViewport(false);
    render(<AppToaster />);
    expect(captured.idle).toHaveLength(1);
    expect(captured.props).toEqual({});
    await act(async () => captured.idle.splice(0).forEach((callback) => callback()));
    await waitFor(() => expect(captured.props.position).toBe("top-right"));
  });
});
