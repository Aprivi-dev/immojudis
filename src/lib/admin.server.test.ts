import { beforeEach, describe, expect, it } from "vitest";
import {
  buildAiDescriptionDashboardStats,
  readAiDescriptionStats,
  readAiDescriptionStatsCached,
  resetAiDescriptionStatsCache,
} from "@/lib/admin.server";

describe("admin dashboard AI description stats", () => {
  it("counts active missing and stale AI descriptions", () => {
    const stats = buildAiDescriptionDashboardStats([
      {
        status: "upcoming",
        llm_display_description: "Synthèse prête. ".repeat(8),
        llm_prompt_version: "auction_llm_v10_structured_display",
        llm_display_quality_version: "display_quality_20260911_v3",
        llm_display_status: "accepted",
      },
      {
        status: "active",
        llm_display_description: "Ancienne synthèse.",
        llm_prompt_version: "auction_llm_v5",
      },
      {
        status: "upcoming",
        llm_display_description: null,
        llm_prompt_version: null,
      },
      {
        status: "past",
      },
      {
        status: "active",
        llm_display_description: "Synthèse avec types invalides. ".repeat(8),
        llm_prompt_version: "auction_llm_v10_structured_display",
        llm_display_quality_version: { invalid: true },
        llm_display_status: 1,
      },
    ]);

    expect(stats).toEqual({
      expectedPromptVersion: "auction_llm_v10_structured_display",
      total: 5,
      activeOrUpcoming: 4,
      ready: 1,
      missing: 1,
      promptVersionMismatch: 2,
      backfillRemaining: 3,
    });
  });

  it("keeps short validated-looking summaries in the backlog", () => {
    const stats = buildAiDescriptionDashboardStats([
      {
        status: "upcoming",
        llm_display_description: "Maison située à Paris.",
        llm_prompt_version: "auction_llm_v10_structured_display",
        llm_display_quality_version: "display_quality_20260911_v3",
        llm_display_status: "fallback",
      },
    ]);
    expect(stats.ready).toBe(0);
    expect(stats.backfillRemaining).toBe(1);
  });

  it("paginates all AI description rows before computing backlog stats", async () => {
    const firstPage = Array.from({ length: 1000 }, () => ({
      status: "past",
      llm_display_description: "Ancienne annonce.",
      llm_prompt_version: "auction_llm_v10_structured_display",
    }));
    const secondPage = [
      {
        status: "active",
        llm_display_description: "Synthèse active. ".repeat(8),
        llm_prompt_version: "auction_llm_v10_structured_display",
        llm_display_quality_version: "display_quality_20260911_v3",
        llm_display_status: "accepted",
      },
    ];
    const ranges: Array<[number, number]> = [];
    const pages = [firstPage, secondPage];
    const admin = {
      from(table: string) {
        expect(table).toBe("auction_sales");
        return {
          select(columns: string) {
            expect(columns).toBe(
              "status,llm_display_description:raw_payload->llm_display_description,llm_prompt_version:raw_payload->llm_prompt_version,llm_display_quality_version:raw_payload->llm_display_quality_version,llm_display_status:raw_payload->llm_display_status",
            );
            return {
              order(column: string, options: { ascending?: boolean }) {
                expect(column).toBe("id");
                expect(options).toEqual({ ascending: true });
                return {
                  range(from: number, to: number) {
                    ranges.push([from, to]);
                    return Promise.resolve({
                      data: pages[ranges.length - 1] ?? [],
                      error: null,
                    });
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof readAiDescriptionStats>[0];

    const stats = await readAiDescriptionStats(admin);

    expect(ranges).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(stats.total).toBe(1001);
    expect(stats.activeOrUpcoming).toBe(1);
    expect(stats.ready).toBe(1);
    expect(stats.backfillRemaining).toBe(0);
  });
});

describe("readAiDescriptionStatsCached", () => {
  function countingAdmin() {
    const reads = { count: 0 };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const admin = {
      from() {
        return {
          select() {
            return {
              order() {
                return {
                  async range() {
                    reads.count += 1;
                    await gate;
                    return {
                      data: [
                        {
                          status: "upcoming",
                          llm_display_description: null,
                          llm_prompt_version: null,
                        },
                      ],
                      error: null,
                    };
                  },
                };
              },
            };
          },
        };
      },
    } as unknown as Parameters<typeof readAiDescriptionStats>[0];
    return { admin, reads, release };
  }

  beforeEach(() => resetAiDescriptionStatsCache());

  it("shares one catalogue read between simultaneous callers", async () => {
    const { admin, reads, release } = countingAdmin();
    const pending = Promise.all([
      readAiDescriptionStatsCached(admin),
      readAiDescriptionStatsCached(admin),
      readAiDescriptionStatsCached(admin),
    ]);
    release();
    const results = await pending;
    expect(reads.count).toBe(1);
    expect(new Set(results.map((stats) => stats.backfillRemaining))).toEqual(new Set([1]));
  });

  it("serves the cached stats for 60 s, then reads again", async () => {
    const { admin, reads, release } = countingAdmin();
    release();
    let clock = 1_000_000;
    const now = () => clock;
    await readAiDescriptionStatsCached(admin, now);
    clock += 59_000;
    await readAiDescriptionStatsCached(admin, now);
    expect(reads.count).toBe(1);
    clock += 2_000;
    await readAiDescriptionStatsCached(admin, now);
    expect(reads.count).toBe(2);
  });

  it("does not cache a failed read", async () => {
    let calls = 0;
    const admin = {
      from() {
        return {
          select: () => ({
            order: () => ({
              range: async () => {
                calls += 1;
                return { data: null, error: { message: "statement timeout" } };
              },
            }),
          }),
        };
      },
    } as unknown as Parameters<typeof readAiDescriptionStats>[0];
    await expect(readAiDescriptionStatsCached(admin)).rejects.toThrow("statement timeout");
    await expect(readAiDescriptionStatsCached(admin)).rejects.toThrow("statement timeout");
    expect(calls).toBe(2);
  });
});
