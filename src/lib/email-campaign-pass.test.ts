import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMAIL_PASS_USER_CONCURRENCY,
  followedSalesInWindow,
  readOncePerSale,
  runEmailPass,
} from "@/lib/email-campaign-pass";

const users = (count: number) => Array.from({ length: count }, (_, index) => `user-${index + 1}`);
const FAR = Number.MAX_SAFE_INTEGER;

afterEach(() => vi.useRealTimers());

describe("runEmailPass", () => {
  it("traite chaque compte une fois, dans l'ordre, par lots de comptes simultanés", async () => {
    const started: string[] = [];
    const running = { now: 0, max: 0 };
    const processUser = async (userId: string) => {
      started.push(userId);
      running.max = Math.max(running.max, (running.now += 1));
      await new Promise((resolve) => setTimeout(resolve, 1));
      running.now -= 1;
    };

    const result = await runEmailPass(users(10), processUser, { deadline: FAR, name: "Test" });

    expect(result).toEqual({ truncated: false });
    expect(started).toEqual(users(10));
    expect(running.max).toBe(EMAIL_PASS_USER_CONCURRENCY);
  });

  it("ne lance aucun lot après l'échéance et le dit, les comptes restants attendant le passage suivant", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000);
    const processed: string[] = [];
    const processUser = async (userId: string) => {
      processed.push(userId);
      // Le premier lot dépasse l'échéance.
      vi.setSystemTime(2_001);
    };

    const result = await runEmailPass(users(10), processUser, { deadline: 2_000, name: "Test" });

    expect(result).toEqual({ truncated: true });
    expect(processed).toEqual(users(EMAIL_PASS_USER_CONCURRENCY));
  });

  it("ne commence pas quand l'échéance est déjà passée", async () => {
    const processUser = vi.fn(async () => undefined);

    const result = await runEmailPass(users(3), processUser, { deadline: 0, name: "Test" });

    expect(result).toEqual({ truncated: true });
    expect(processUser).not.toHaveBeenCalled();
  });

  it("échoue au premier compte rejeté, après son lot, sans lancer le lot suivant", async () => {
    const reading = new Error("base injoignable");
    const processed: string[] = [];
    const processUser = async (userId: string) => {
      processed.push(userId);
      if (userId === "user-2") throw reading;
    };

    await expect(
      runEmailPass(users(10), processUser, { deadline: FAR, name: "Test" }),
    ).rejects.toBe(reading);
    expect(processed).toEqual(users(EMAIL_PASS_USER_CONCURRENCY));
  });

  it("nomme le passage quand le rejet n'est pas une erreur", async () => {
    const processUser = async () => {
      throw "refus";
    };

    await expect(
      runEmailPass(users(1), processUser, { deadline: FAR, name: "Weekly digest" }),
    ).rejects.toThrow("Weekly digest: user processing failed.");
  });

  it("ne fait rien sans destinataire", async () => {
    const processUser = vi.fn(async () => undefined);

    await expect(runEmailPass([], processUser, { deadline: 0, name: "Test" })).resolves.toEqual({
      truncated: false,
    });
    expect(processUser).not.toHaveBeenCalled();
  });
});

describe("readOncePerSale", () => {
  it("lit chaque vente une seule fois, même pendant une lecture en cours", async () => {
    const read = vi.fn(async (saleId: string) => `row-${saleId}`);
    const readOnce = readOncePerSale(read);

    const [a, again] = await Promise.all([readOnce("a"), readOnce("a")]);
    await readOnce("b");

    expect([a, again]).toEqual(["row-a", "row-a"]);
    expect(read.mock.calls).toEqual([["a"], ["b"]]);
  });
});

describe("followedSalesInWindow", () => {
  // Jeudi 3 novembre 2026, 07 h à Paris.
  const NOW = new Date("2026-11-03T06:00:00Z");

  it("garde les ventes d'aujourd'hui à `maxDays` jours (jours de Paris), les plus proches d'abord", () => {
    const sales = [
      { id: "later", saleDate: "2026-11-10T09:00:00Z" },
      { id: "yesterday", saleDate: "2026-11-02T22:59:00Z" },
      { id: "today-b", saleDate: "2026-11-02T23:30:00Z" },
      { id: "today-a", saleDate: "2026-11-03T15:00:00Z" },
      { id: "too-far", saleDate: "2026-11-11T09:00:00Z" },
      { id: "unknown", saleDate: null },
      { id: "unreadable", saleDate: "pas une date" },
    ];

    const result = followedSalesInWindow(sales, NOW, { maxDays: 7, limit: 10 });

    expect(result).toEqual({
      sales: [sales[3], sales[2], sales[0]],
      truncated: false,
    });
  });

  it("garde `limit` ventes au plus et signale les autres", () => {
    const sales = ["c", "a", "b"].map((id) => ({ id, saleDate: "2026-11-04T09:00:00Z" }));

    const result = followedSalesInWindow(sales, NOW, { maxDays: 7, limit: 2 });

    expect(result.sales.map((sale) => sale.id)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(true);
  });
});
