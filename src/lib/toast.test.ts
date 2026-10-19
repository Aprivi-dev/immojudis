// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOAST_QUEUE_LIMIT,
  isToastRequested,
  registerToaster,
  resetToastForTests,
  subscribeToastRequest,
  toast,
} from "./toast";

type RealToast = Parameters<typeof registerToaster>[0] & object;

function fakeSonner() {
  const calls: Array<[string, unknown, Record<string, unknown> | undefined]> = [];
  const record = (name: string) =>
    vi.fn((message: unknown, options?: Record<string, unknown>) => {
      calls.push([name, message, options]);
      return options?.id ?? `sonner-${calls.length}`;
    });
  const real = Object.assign(record("default"), {
    success: record("success"),
    error: record("error"),
    info: record("info"),
    warning: record("warning"),
    message: record("message"),
    loading: record("loading"),
    dismiss: vi.fn((id?: string | number) => id ?? "all"),
  }) as unknown as RealToast;
  return { real, calls };
}

beforeEach(() => {
  resetToastForTests();
});

describe("toast", () => {
  it("ne charge rien tant qu'aucune notification n'est émise", () => {
    const onRequest = vi.fn();
    subscribeToastRequest(onRequest);
    expect(isToastRequested()).toBe(false);
    expect(onRequest).not.toHaveBeenCalled();
  });

  it("demande le chargement à la première notification, une seule fois", () => {
    const onRequest = vi.fn();
    subscribeToastRequest(onRequest);

    toast.success("Un");
    toast.error("Deux");

    expect(isToastRequested()).toBe(true);
    expect(onRequest).toHaveBeenCalledTimes(1);
  });

  it("garde les notifications émises avant l'affichage et les rejoue dans l'ordre", () => {
    const { real, calls } = fakeSonner();
    const action = { label: "Annuler", onClick: vi.fn() };

    toast.success("Ajoutée", { description: "Détail" });
    toast("Supprimée", { action });
    toast.error("Échec");
    toast.message("Info");
    expect(calls).toHaveLength(0);

    registerToaster(real);

    expect(calls.map(([name, message]) => [name, message])).toEqual([
      ["success", "Ajoutée"],
      ["default", "Supprimée"],
      ["error", "Échec"],
      ["message", "Info"],
    ]);
    expect(calls[0][2]).toMatchObject({ description: "Détail" });
    expect(calls[1][2]?.action).toBe(action);
  });

  it("appelle sonner directement une fois le composant affiché", () => {
    const { real, calls } = fakeSonner();
    registerToaster(real);

    const id = toast.success("Direct", { id: "a" });

    expect(id).toBe("a");
    expect(calls).toEqual([["success", "Direct", { id: "a" }]]);
  });

  it("ne rejoue pas deux fois la même notification", () => {
    const { real, calls } = fakeSonner();
    toast.info("Une fois");
    registerToaster(real);
    registerToaster(null);
    registerToaster(real);

    expect(calls).toHaveLength(1);
  });

  it("remet les notifications en file si le composant est démonté (puis remonté)", () => {
    const first = fakeSonner();
    const second = fakeSonner();
    registerToaster(first.real);
    registerToaster(null);

    toast.warning("Pendant le remontage");
    expect(first.calls).toHaveLength(0);

    registerToaster(second.real);
    expect(second.calls.map(([name, message]) => [name, message])).toEqual([
      ["warning", "Pendant le remontage"],
    ]);
  });

  it("rend tout de suite un identifiant utilisable pour fermer une notification en file", () => {
    const { real, calls } = fakeSonner();
    const loading = toast.loading("Envoi…");
    const kept = toast.success("Autre");
    expect(loading).not.toBe(kept);

    toast.dismiss(loading);
    registerToaster(real);

    expect(calls.map(([name, message]) => [name, message])).toEqual([["success", "Autre"]]);
    expect(calls[0][2]).toMatchObject({ id: kept });
  });

  it("vide toute la file avec dismiss() sans identifiant", () => {
    const { real, calls } = fakeSonner();
    toast.success("A");
    toast.success("B");
    toast.dismiss();
    registerToaster(real);

    expect(calls).toHaveLength(0);
  });

  it("transmet dismiss à sonner une fois affiché", () => {
    const { real } = fakeSonner();
    registerToaster(real);

    expect(toast.dismiss("x")).toBe("x");
    expect(real.dismiss).toHaveBeenCalledWith("x");
  });

  it("borne la file en écartant les plus anciennes", () => {
    const { real, calls } = fakeSonner();
    for (let i = 0; i < TOAST_QUEUE_LIMIT + 5; i += 1) toast.message(`n${i}`);
    registerToaster(real);

    expect(calls).toHaveLength(TOAST_QUEUE_LIMIT);
    expect(calls[0][1]).toBe("n5");
    expect(calls.at(-1)?.[1]).toBe(`n${TOAST_QUEUE_LIMIT + 4}`);
  });

  it("n'interrompt pas la file si une notification lève", () => {
    const { real, calls } = fakeSonner();
    vi.mocked(real.error).mockImplementationOnce(() => {
      throw new Error("sonner");
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    toast.error("Casse");
    toast.success("Passe");

    registerToaster(real);

    expect(calls.map(([name]) => name)).toEqual(["success"]);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
