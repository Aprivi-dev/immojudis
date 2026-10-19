// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  props: {} as Record<string, unknown>,
  success: undefined as unknown,
}));
vi.mock("sonner", () => {
  const success = Object.assign(vi.fn(), {});
  captured.success = success;
  return {
    Toaster: (props: Record<string, unknown>) => {
      captured.props = props;
      return null;
    },
    toast: Object.assign(vi.fn(), { success, dismiss: vi.fn() }),
  };
});

import { resetToastForTests, toast } from "@/lib/toast";
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

beforeEach(() => {
  resetToastForTests();
});

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

  it("affiche les notifications émises avant son chargement, puis les suivantes directement", () => {
    mockViewport(false);
    const success = captured.success as ReturnType<typeof vi.fn>;
    success.mockClear();
    toast.success("En file", { description: "Avant le chargement" });
    expect(success).not.toHaveBeenCalled();

    render(<AppToaster />);

    expect(success).toHaveBeenCalledTimes(1);
    expect(success.mock.calls[0][0]).toBe("En file");
    expect(success.mock.calls[0][1]).toMatchObject({ description: "Avant le chargement" });

    toast.success("Directe");
    expect(success).toHaveBeenCalledTimes(2);
  });

  it("remet les notifications en file quand il est démonté", () => {
    mockViewport(false);
    const success = captured.success as ReturnType<typeof vi.fn>;
    success.mockClear();
    const { unmount } = render(<AppToaster />);
    unmount();

    toast.success("Après le démontage");

    expect(success).not.toHaveBeenCalled();
  });
});
