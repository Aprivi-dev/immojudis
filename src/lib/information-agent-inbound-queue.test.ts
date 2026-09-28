import { beforeEach, describe, expect, it, vi } from "vitest";
import { runInformationAgentInboundQueue } from "@/lib/information-agent-inbound";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  jobUpdate: vi.fn(),
  messageUpdate: vi.fn(),
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: mocks.rpc,
    from: mocks.from,
  },
}));

function jobFixture(attempts = 1) {
  return {
    id: "job-1",
    message_id: "message-1",
    case_id: "case-1",
    provider_email_id: "provider-1",
    status: "processing",
    attempts,
    available_at: "2026-09-28T10:00:00.000Z",
    locked_at: "2026-09-28T10:00:00.000Z",
    lease_id: "lease-1",
    attachment_link_expires_at: "2026-09-28T10:55:00.000Z",
    last_error: null,
    created_at: "2026-09-28T10:00:00.000Z",
    updated_at: "2026-09-28T10:00:00.000Z",
  } as const;
}

function configureCaseLookup(
  data: unknown,
  error: unknown = null,
  messageMetadata: Record<string, unknown> = {
    inbound_processing: {
      version: "inbound-v2",
      status: "queued",
      attempts: 0,
      provider_email_id: "provider-1",
      queued_at: "2026-09-28T10:00:00.000Z",
    },
  },
) {
  mocks.from.mockImplementation((table: string) => {
    if (table === "information_agent_cases") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data, error }) }),
        }),
      };
    }
    if (table === "information_agent_messages") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { metadata: messageMetadata }, error: null }),
          }),
        }),
        update: (values: unknown) => {
          mocks.messageUpdate(values);
          return { eq: async () => ({ error: null }) };
        },
      };
    }
    if (table === "information_agent_inbound_jobs") {
      return {
        update: (values: unknown) => {
          mocks.jobUpdate(values);
          return {
            eq: () => ({ eq: async () => ({ error: null }) }),
          };
        },
      };
    }
    throw new Error(`Unexpected table ${table}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("information-agent inbound durable queue", () => {
  it("returns a bounded empty claim without touching external links", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: [], error: null });

    await expect(
      runInformationAgentInboundQueue({
        env: {
          NODE_ENV: "test",
          RESEND_API_KEY: "resend-test-key",
          INFORMATION_AGENT_INBOUND_DOMAIN: "reponses.immojudis.com",
        },
        limit: 5,
      }),
    ).resolves.toMatchObject({ claimed: 0, completed: 0, failed: 0 });
    expect(mocks.rpc).toHaveBeenCalledWith("claim_information_agent_inbound_jobs", {
      p_limit: 5,
      p_now: expect.any(String),
    });
  });

  it("returns a failed job to the queue when its case disappeared", async () => {
    const job = jobFixture();
    mocks.rpc.mockResolvedValueOnce({ data: [job], error: null });
    configureCaseLookup(null);

    const result = await runInformationAgentInboundQueue({
      env: {
        NODE_ENV: "test",
        RESEND_API_KEY: "resend-test-key",
        INFORMATION_AGENT_INBOUND_DOMAIN: "reponses.immojudis.com",
      },
      now: new Date("2026-09-28T10:01:00.000Z"),
      limit: 1,
    });

    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    expect(mocks.jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        lease_id: null,
        available_at: "2026-09-28T10:01:30.000Z",
      }),
    );
  });

  it("marks the receipt ignored when its case closed before worker processing", async () => {
    const job = jobFixture();
    mocks.rpc.mockResolvedValueOnce({ data: [job], error: null });
    configureCaseLookup({ status: "completed" });

    const result = await runInformationAgentInboundQueue({
      env: {
        NODE_ENV: "test",
        RESEND_API_KEY: "resend-test-key",
        INFORMATION_AGENT_INBOUND_DOMAIN: "reponses.immojudis.com",
      },
      now: new Date("2026-09-28T10:01:00.000Z"),
      limit: 1,
    });

    expect(result).toMatchObject({ claimed: 1, ignored: 1, failed: 0 });
    expect(mocks.messageUpdate).toHaveBeenCalledWith({
      metadata: expect.objectContaining({
        processing_ignored_case_status: "completed",
        inbound_processing: expect.objectContaining({
          status: "ignored",
          reason: "case_closed",
        }),
      }),
    });
    expect(mocks.jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ignored", lease_id: null }),
    );
  });

  it("moves a job to review after its retry budget is exhausted", async () => {
    const job = jobFixture(10);
    mocks.rpc.mockResolvedValueOnce({ data: [job], error: null });
    configureCaseLookup(null);

    const result = await runInformationAgentInboundQueue({
      env: {
        NODE_ENV: "test",
        RESEND_API_KEY: "resend-test-key",
        INFORMATION_AGENT_INBOUND_DOMAIN: "reponses.immojudis.com",
      },
      now: new Date("2026-09-28T10:01:00.000Z"),
      limit: 1,
    });

    expect(result).toMatchObject({ claimed: 1, failed: 1 });
    expect(mocks.jobUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "review", lease_id: null }),
    );
  });
});
