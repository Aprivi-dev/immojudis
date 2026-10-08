import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InformationAgentWebhookPayloadTooLargeError,
  processInformationAgentInboundWebhook,
} from "@/lib/information-agent-inbound";

const mocks = vi.hoisted(() => ({
  verify: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  from: vi.fn(),
  storageFrom: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    webhooks = { verify: mocks.verify };
    emails = { receiving: { get: mocks.get, attachments: { list: mocks.list } } };
  },
}));
vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    from: mocks.from,
    storage: { from: mocks.storageFrom },
  },
}));

const SALE_A = "11111111-1111-4111-8111-111111111111";
const SALE_B = "22222222-2222-4222-8222-222222222222";
const CASE_A = "33333333-3333-4333-8333-333333333333";
const CASE_B = "44444444-4444-4444-8444-444444444444";
const MISSION_A = "55555555-5555-4555-8555-555555555555";
const MISSION_B = "66666666-6666-4666-8666-666666666666";
const TOKEN_A = "77777777-7777-4777-8777-777777777777";
const TOKEN_B = "88888888-8888-4888-8888-888888888888";
const DOMAIN = "reponses.immojudis.com";
const address = (token: string) => `enquete+${token}@${DOMAIN}`;

type Row = Record<string, unknown>;

function fixture({
  concurrentAssetLookup = false,
  closeCaseBeforeFinalUpdate = false,
  moveCaseToReviewBeforeFinalUpdate = false,
  bodyAssetCollisionSha256,
}: {
  concurrentAssetLookup?: boolean;
  closeCaseBeforeFinalUpdate?: boolean;
  moveCaseToReviewBeforeFinalUpdate?: boolean;
  bodyAssetCollisionSha256?: string;
} = {}) {
  const cases: Row[] = [
    {
      id: CASE_A,
      sale_id: SALE_A,
      inbound_token: TOKEN_A,
      initiator_mission_id: MISSION_A,
      normalized_recipient_email: "contact@example.test",
      subject: "Vente A",
      status: "sent",
      metadata: {},
    },
    {
      id: CASE_B,
      sale_id: SALE_B,
      inbound_token: TOKEN_B,
      initiator_mission_id: MISSION_B,
      normalized_recipient_email: "contact@example.test",
      subject: "Vente B",
      status: "sent",
      metadata: {},
    },
  ];
  const missions: Row[] = [
    { id: MISSION_A, case_id: CASE_A, user_id: SALE_A, status: "sent" },
    { id: MISSION_B, case_id: CASE_B, user_id: SALE_B, status: "sent" },
  ];
  const messages: Row[] = [];
  const assets: Row[] = [];
  const bodyAssets: Row[] = [];
  const evidenceAssets: Row[] = [];
  const facts: Row[] = [];
  const jobs: Row[] = [];
  const contacts: Row[] = [];
  const uploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const bodyUploads: Array<{ path: string; bytes: Uint8Array }> = [];
  const operations: string[] = [];
  let messageMetadataWrites = 0;
  let assetLookupCount = 0;
  let closeCaseBeforeNextUpdate = closeCaseBeforeFinalUpdate;
  let moveCaseToReviewBeforeNextUpdate = moveCaseToReviewBeforeFinalUpdate;
  let bodyAssetCollisionConsumed = false;
  let releaseAssetLookups: () => void = () => {};
  const assetLookupsReady = new Promise<void>((resolve) => {
    releaseAssetLookups = resolve;
  });
  const tables: Record<string, Row[]> = {
    information_agent_cases: cases,
    information_agent_missions: missions,
    information_agent_messages: messages,
    information_agent_evidence_assets: evidenceAssets,
    information_agent_fact_candidates: facts,
    information_agent_inbound_jobs: jobs,
    information_agent_contacts: contacts,
    auction_sales: [
      {
        id: SALE_A,
        surface_m2: null,
        app_surface_m2: null,
        rooms_count: null,
        occupancy_status: null,
      },
      {
        id: SALE_B,
        surface_m2: null,
        app_surface_m2: null,
        rooms_count: null,
        occupancy_status: null,
      },
    ],
  };

  class Query implements PromiseLike<{ data: Row[] | null; error: null }> {
    private conditions: Array<(row: Row) => boolean> = [];
    private operation: "select" | "insert" | "update" = "select";
    private values: Row | Row[] | null = null;
    constructor(private table: string) {}
    select() {
      return this;
    }
    eq(key: string, value: unknown) {
      this.conditions.push((row) => row[key] === value);
      return this;
    }
    in(key: string, values: unknown[]) {
      this.conditions.push((row) => values.includes(row[key]));
      return this;
    }
    order() {
      return this;
    }
    limit() {
      return this;
    }
    insert(values: Row | Row[]) {
      this.operation = "insert";
      this.values = values;
      return this;
    }
    update(values: Row) {
      this.operation = "update";
      this.values = values;
      return this;
    }
    upsert(values: Row | Row[]) {
      for (const row of Array.isArray(values) ? values : [values]) {
        if (this.table === "information_agent_fact_candidates") {
          operations.push("fact_candidates");
          if (
            !facts.some(
              (fact) =>
                fact.message_id === row.message_id &&
                fact.fact_key === row.fact_key &&
                fact.evidence_asset_id === row.evidence_asset_id &&
                fact.source_page === row.source_page &&
                fact.display_value === row.display_value,
            )
          )
            facts.push(row);
        } else if (
          this.table === "information_agent_inbound_jobs" &&
          !jobs.some((job) => job.provider_email_id === row.provider_email_id)
        ) {
          jobs.push({ ...row, id: row.id ?? `job-${jobs.length + 1}` });
        } else if (
          this.table === "information_agent_contacts" &&
          !contacts.some(
            (contact) =>
              contact.scope_sale_id === row.scope_sale_id &&
              String(contact.email).toLowerCase() === String(row.email).toLowerCase(),
          )
        ) {
          contacts.push({ ...row, id: row.id ?? `contact-${contacts.length + 1}` });
        } else if (this.table === "information_agent_contacts") {
          const existing = contacts.find(
            (contact) =>
              contact.scope_sale_id === row.scope_sale_id &&
              String(contact.email).toLowerCase() === String(row.email).toLowerCase(),
          );
          if (existing) Object.assign(existing, row);
        }
      }
      return Promise.resolve({ data: null, error: null });
    }
    async maybeSingle() {
      const result = this.execute();
      if (
        concurrentAssetLookup &&
        this.table === "information_agent_evidence_assets" &&
        assetLookupCount < 2
      ) {
        assetLookupCount += 1;
        if (assetLookupCount === 2) releaseAssetLookups();
        await assetLookupsReady;
      }
      return { data: result.data[0] ?? null, error: result.error };
    }
    async single() {
      const result = this.execute();
      return { data: result.data[0] ?? null, error: result.error };
    }
    then<TResult1 = { data: Row[] | null; error: null }, TResult2 = never>(
      onfulfilled?:
        | ((value: { data: Row[] | null; error: null }) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): Promise<TResult1 | TResult2> {
      return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
    }
    private execute(): { data: Row[]; error: null } {
      const rows = tables[this.table];
      if (!rows) throw new Error(`Unexpected table: ${this.table}`);
      if (this.operation === "insert") {
        const incoming = Array.isArray(this.values) ? this.values : [this.values as Row];
        for (const row of incoming) {
          const metadata = row.metadata;
          if (
            this.table === "information_agent_evidence_assets" &&
            bodyAssetCollisionSha256 &&
            !bodyAssetCollisionConsumed &&
            metadata &&
            typeof metadata === "object" &&
            !Array.isArray(metadata) &&
            (metadata as Record<string, unknown>).evidence_kind === "email_body"
          ) {
            bodyAssetCollisionConsumed = true;
            const collision: Row = {
              ...row,
              id: "concurrent-body-asset",
              sha256: bodyAssetCollisionSha256,
            };
            rows.push(collision);
            bodyAssets.push(collision);
            operations.push("email_body_asset_collision");
            return { data: [], error: { code: "23505" } as never };
          }
          if (
            this.table === "information_agent_messages" &&
            messages.some((message) => message.provider_message_id === row.provider_message_id)
          ) {
            return { data: [], error: { code: "23505" } as never };
          }
          if (
            this.table === "information_agent_evidence_assets" &&
            evidenceAssets.some(
              (asset) =>
                asset.message_id === row.message_id &&
                asset.provider_attachment_id === row.provider_attachment_id,
            )
          ) {
            return { data: [], error: { code: "23505" } as never };
          }
          const inserted: Row = { ...row, id: row.id ?? `asset-${evidenceAssets.length + 1}` };
          rows.push(inserted);
          if (this.table === "information_agent_evidence_assets") {
            const metadata = inserted.metadata;
            if (
              metadata &&
              typeof metadata === "object" &&
              !Array.isArray(metadata) &&
              (metadata as Record<string, unknown>).evidence_kind === "email_body"
            ) {
              operations.push("email_body_asset");
              bodyAssets.push(inserted);
            } else {
              assets.push(inserted);
            }
          }
        }
        return {
          data: incoming.map((row) => rows.find((item) => item.id === row.id) ?? rows.at(-1)!),
          error: null,
        };
      }
      if (
        closeCaseBeforeNextUpdate &&
        this.table === "information_agent_cases" &&
        this.operation === "update"
      ) {
        closeCaseBeforeNextUpdate = false;
        const target = cases.find((row) => row.id === CASE_A);
        if (target) target.status = "completed";
      }
      if (
        moveCaseToReviewBeforeNextUpdate &&
        this.table === "information_agent_cases" &&
        this.operation === "update"
      ) {
        moveCaseToReviewBeforeNextUpdate = false;
        const target = cases.find((row) => row.id === CASE_A);
        if (target) target.status = "review";
      }
      const selected = rows.filter((row) => this.conditions.every((condition) => condition(row)));
      if (this.operation === "update") {
        if (this.table === "information_agent_messages") messageMetadataWrites += 1;
        selected.forEach((row) => Object.assign(row, this.values));
      }
      return { data: selected, error: null };
    }
  }

  mocks.from.mockImplementation((table: string) => new Query(table));
  mocks.storageFrom.mockReturnValue({
    upload: vi.fn(async (path: string, bytes: Uint8Array) => {
      if (path.includes("/body/")) bodyUploads.push({ path, bytes });
      else uploads.push({ path, bytes });
      return { error: null };
    }),
  });
  return {
    cases,
    missions,
    messages,
    assets,
    bodyAssets,
    facts,
    jobs,
    contacts,
    uploads,
    bodyUploads,
    operations,
    messageMetadataWrites: () => messageMetadataWrites,
  };
}

function receivedEmail({
  token = TOKEN_A,
  from = "Contact <contact@example.test>",
  text = "La surface habitable est de 84 m². Il y a 4 pièces.",
  authentication = { spf: "pass", dkim: "pass", dmarc: "pass" },
}: {
  token?: string;
  from?: string;
  text?: string;
  authentication?: { spf?: string; dkim?: string; dmarc?: string } | null;
} = {}) {
  mocks.verify.mockReturnValue({
    type: "email.received",
    created_at: "2026-09-23T10:00:00.000Z",
    data: { email_id: "provider-email-1", to: [address(token)], received_for: [address(token)] },
  });
  mocks.get.mockResolvedValue({
    data: {
      from,
      to: [address(token)],
      subject: "Re: Vente A",
      text,
      html: null,
      created_at: "2026-09-23T10:00:00.000Z",
      authentication,
    },
    error: null,
  });
  mocks.list.mockResolvedValue({ data: { data: [] }, error: null });
}

function webhook(
  fetchImpl = vi.fn(),
  body = "signed local fixture",
  additionalHeaders: HeadersInit = {},
  deferProcessing = false,
  envOverrides: Partial<Omit<NodeJS.ProcessEnv, "NODE_ENV">> = {},
): Promise<Awaited<ReturnType<typeof processInformationAgentInboundWebhook>>> {
  const request = new Request("https://example.test/api/webhooks/resend/information-agent", {
    method: "POST",
    headers: {
      "svix-id": "id",
      "svix-timestamp": "timestamp",
      "svix-signature": "signature",
      ...additionalHeaders,
    },
    body,
  });
  return processInformationAgentInboundWebhook({
    request,
    env: {
      NODE_ENV: "test",
      RESEND_API_KEY: "fixture-key",
      RESEND_WEBHOOK_SECRET: "fixture-secret",
      INFORMATION_AGENT_INBOUND_DOMAIN: DOMAIN,
      ...envOverrides,
    },
    fetchImpl: fetchImpl as typeof fetch,
    deferProcessing,
  });
}

beforeEach(() => vi.resetAllMocks());

describe("information-agent offline inbound scenarios", () => {
  it("rejects an oversized declared body before signature verification", async () => {
    await expect(
      webhook(vi.fn(), "fixture", { "content-length": "300000" }),
    ).rejects.toBeInstanceOf(InformationAgentWebhookPayloadTooLargeError);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body without buffering it in full", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(200_000)));
        controller.enqueue(new TextEncoder().encode("x".repeat(100_000)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://example.test/api/webhooks/resend/information-agent", {
      method: "POST",
      headers: {
        "svix-id": "id",
        "svix-timestamp": "timestamp",
        "svix-signature": "signature",
      },
      body: stream,
      duplex: "half",
    } as RequestInit);

    await expect(
      processInformationAgentInboundWebhook({
        request,
        env: {
          NODE_ENV: "test",
          RESEND_API_KEY: "fixture-key",
          RESEND_WEBHOOK_SECRET: "fixture-secret",
          INFORMATION_AGENT_INBOUND_DOMAIN: DOMAIN,
        },
      }),
    ).rejects.toBeInstanceOf(InformationAgentWebhookPayloadTooLargeError);
    expect(cancelled).toBe(true);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before reading a case", async () => {
    fixture();
    receivedEmail();
    mocks.verify.mockImplementationOnce(() => {
      throw new Error("Invalid signature");
    });

    await expect(webhook()).rejects.toMatchObject({
      name: "InvalidInformationAgentWebhookSignatureError",
    });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("associates a reply and its attachment with only the token's sale, then stays idempotent", async () => {
    const state = fixture();
    receivedEmail();
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "attachment-1",
            filename: "pv.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "https://example.test/pv.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response("%PDF-1.7\nfixture", { status: 200 }));

    const first = await webhook(fetchImpl);
    const second = await webhook(fetchImpl);

    expect(first).toMatchObject({
      accepted: true,
      caseId: CASE_A,
      factCount: 3,
      attachmentCount: 1,
    });
    expect(second).toMatchObject({ accepted: true, caseId: CASE_A });
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(1);
    expect(state.facts).toHaveLength(3);
    expect(state.assets[0]).toMatchObject({ case_id: CASE_A, sale_id: SALE_A });
    expect(state.facts.every((fact) => fact.case_id === CASE_A && fact.sale_id === SALE_A)).toBe(
      true,
    );
    expect(state.cases[1]?.status).toBe("sent");
    expect(state.uploads).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stores the cleaned email body as private evidence for the extraction worker", async () => {
    const state = fixture();
    receivedEmail({
      text: [
        "Bonjour,",
        "La surface habitable est de 84 m².",
        "",
        "--",
        "Le 20 septembre, ImmoJudis a écrit :",
        "> La surface habitable est de 18 m².",
      ].join("\n"),
    });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({
      factCount: 1,
      attachmentCount: 0,
      processingStatus: "review",
    });
    expect(state.assets).toHaveLength(0);
    expect(state.bodyAssets).toHaveLength(1);
    expect(state.operations.indexOf("fact_candidates")).toBeLessThan(
      state.operations.indexOf("email_body_asset"),
    );
    expect(state.bodyAssets[0]).toMatchObject({
      case_id: CASE_A,
      sale_id: SALE_A,
      provider_attachment_id: expect.stringMatching(/^email-body:/),
      storage_bucket: "information-agent-evidence",
      original_filename: "email-body.txt",
      mime_type: "text/plain",
      metadata: {
        evidence_kind: "email_body",
        content_trust: "untrusted_external_evidence",
      },
    });
    expect(new TextDecoder().decode(state.bodyUploads[0]?.bytes)).toBe(
      "Bonjour,\nLa surface habitable est de 84 m².",
    );
    expect(
      state.facts.every((fact) => !["document", "photo"].includes(String(fact.fact_key))),
    ).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not reuse a concurrent body asset with a different SHA", async () => {
    const state = fixture({ bodyAssetCollisionSha256: "0".repeat(64) });
    receivedEmail({ text: "Surface habitable : 84 m²." });

    await expect(webhook()).rejects.toThrow("contenu différent");
    expect(state.bodyAssets).toHaveLength(1);
    expect(state.bodyAssets[0]?.sha256).toBe("0".repeat(64));
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: { status: "failed" },
    });
  });

  it("persists a verified receipt before attachment processing when deferred", async () => {
    const state = fixture();
    receivedEmail();
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl, "fixture", {}, true)).toMatchObject({
      accepted: true,
      caseId: CASE_A,
      processingStatus: "queued",
      attachmentCount: 0,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.jobs).toHaveLength(1);
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: { status: "queued", attempts: 0 },
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reviews a deferred receipt with unverified authentication before creating a job", async () => {
    const state = fixture();
    receivedEmail({ authentication: { spf: "pass", dkim: "pass", dmarc: "gray" } });
    const fetchImpl = vi.fn();

    expect(
      await webhook(fetchImpl, "fixture", {}, true, {
        INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION: "true",
      }),
    ).toMatchObject({
      caseId: CASE_A,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "review",
    });
    expect(state.jobs).toHaveLength(0);
    expect(state.messages[0]?.metadata).toMatchObject({
      sender_authentication: {
        status: "unverified",
        spf: "pass",
        dkim: "pass",
        dmarc: "gray",
      },
      inbound_processing: { status: "review", reason: "sender_authentication_unverified" },
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("persists a completed processing checkpoint and skips attachment work on a replay", async () => {
    const state = fixture();
    receivedEmail({ text: "Merci pour votre retour." });
    mocks.list.mockResolvedValue({ data: { data: [] }, error: null });
    const fetchImpl = vi.fn();

    const first = await webhook(fetchImpl);
    const writesAfterFirstDelivery = state.messageMetadataWrites();
    const second = await webhook(fetchImpl);

    expect(first).toMatchObject({ processingStatus: "review" });
    expect(second).toMatchObject({ processingStatus: "review", duplicate: true });
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: {
        version: "inbound-v2",
        status: "review",
        attempts: 1,
        provider_email_id: "provider-email-1",
      },
    });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.messageMetadataWrites()).toBe(writesAfterFirstDelivery);
  });

  it("keeps a case in review when a later inbound reply has no new fact", async () => {
    const state = fixture();
    state.cases[0]!.status = "review";
    receivedEmail({ text: "Merci pour votre retour, nous vérifions le dossier." });
    mocks.list.mockResolvedValue({ data: { data: [] }, error: null });

    expect(await webhook()).toMatchObject({ processingStatus: "review", factCount: 0 });
    expect(state.cases[0]?.status).toBe("review");
  });

  it("preserves review when a concurrent reply changes the case after the snapshot", async () => {
    const state = fixture({ moveCaseToReviewBeforeFinalUpdate: true });
    receivedEmail({ text: "Merci pour votre retour, nous vérifions le dossier." });

    expect(await webhook()).toMatchObject({ processingStatus: "review", factCount: 0 });
    expect(state.cases[0]?.status).toBe("review");
    expect(state.missions[0]?.status).toBe("replied");
  });

  it("keeps a failed checkpoint retryable and advances the attempt on the next delivery", async () => {
    const state = fixture();
    receivedEmail({ text: "Merci." });
    mocks.list
      .mockRejectedValueOnce(new Error("temporary Resend failure"))
      .mockResolvedValueOnce({ data: { data: [] }, error: null });

    await expect(webhook()).rejects.toThrow("temporary Resend failure");
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: {
        status: "failed",
        attempts: 1,
        last_error: "temporary Resend failure",
      },
    });

    const retry = await webhook();
    expect(retry).toMatchObject({ processingStatus: "review" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: { status: "review", attempts: 2 },
    });
  });

  it("handles two concurrent deliveries without duplicate messages, assets, or facts", async () => {
    const state = fixture({ concurrentAssetLookup: true });
    receivedEmail();
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "attachment-race",
            filename: "pv.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "https://example.test/pv.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response("%PDF-1.7\nfixture", { status: 200 }));

    const results = await Promise.all([webhook(fetchImpl), webhook(fetchImpl)]);

    expect(results.every((result) => result.accepted && result.attachmentCount === 1)).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(1);
    expect(state.facts).toHaveLength(3);
  });

  it("keeps distinct attachments with the same bytes and filename reviewable", async () => {
    const state = fixture();
    receivedEmail({ text: "Deux exemplaires sont joints." });
    mocks.list.mockResolvedValue({
      data: {
        data: ["attachment-a", "attachment-b"].map((id) => ({
          id,
          filename: "document.pdf",
          content_type: "application/pdf",
          size: 16,
          download_url: "https://example.test/document.pdf",
          content_disposition: "attachment",
        })),
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response("%PDF-1.7\nfixture", { status: 200 }));

    expect(await webhook(fetchImpl)).toMatchObject({ attachmentCount: 2, factCount: 2 });
    expect(state.assets).toHaveLength(2);
    expect(state.facts).toHaveLength(2);
    expect(new Set(state.facts.map((fact) => fact.evidence_asset_id)).size).toBe(2);
    expect(state.facts.map((fact) => fact.display_value)).toEqual(["document.pdf", "document.pdf"]);
    expect(new Set(state.uploads.map((upload) => upload.path)).size).toBe(2);
  });

  it("keeps a valid attachment visible when another download is unavailable", async () => {
    const state = fixture();
    receivedEmail({ text: "Pièces jointes." });
    mocks.list.mockResolvedValue({
      data: {
        data: ["good", "missing"].map((id) => ({
          id,
          filename: `${id}.pdf`,
          content_type: "application/pdf",
          size: 16,
          download_url: `https://example.test/${id}.pdf`,
          content_disposition: "attachment",
        })),
      },
      error: null,
    });
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("%PDF-1.7\nfixture", { status: 200 }))
      .mockResolvedValueOnce(new Response("", { status: 404 }));

    expect(await webhook(fetchImpl)).toMatchObject({ attachmentCount: 1, factCount: 1 });
    expect(state.assets).toHaveLength(1);
    expect(state.facts).toHaveLength(1);
    expect(state.messages[0]?.metadata).toMatchObject({
      rejected_attachment_count: 1,
      rejected_attachments: [
        { filename: "missing.pdf", reason: expect.stringContaining("HTTP 404") },
      ],
    });
    expect(state.cases[0]?.status).toBe("review");
  });

  it("rejects malformed attachment metadata before downloading it", async () => {
    const state = fixture();
    receivedEmail({ text: "Pièce jointe." });
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "malformed-size",
            filename: "document.pdf",
            content_type: "application/pdf",
            size: Number.NaN,
            download_url: "https://example.test/document.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({
      attachmentCount: 0,
      processingStatus: "review",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(state.messages[0]?.metadata).toMatchObject({
      rejected_attachment_count: 1,
      rejected_attachments: [{ filename: "document.pdf", reason: "Taille hors limite" }],
    });
  });

  it("normalizes provider MIME aliases and rejects insecure attachment links", async () => {
    const state = fixture();
    receivedEmail({ text: "Pièces jointes." });
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "pdf-alias",
            filename: "pv.pdf",
            content_type: "application/x-pdf; charset=binary",
            size: 16,
            download_url: "https://example.test/pv.pdf",
          },
          {
            id: "photo-generic",
            filename: "photo.JPG",
            content_type: "application/octet-stream",
            size: 16,
            download_url: "https://example.test/photo.JPG",
          },
          {
            id: "table-alias",
            filename: "table.csv",
            content_type: "text/csv",
            size: 16,
            download_url: "https://example.test/table.csv",
          },
          {
            id: "insecure",
            filename: "unsafe.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "http://example.test/unsafe.pdf",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response("fixture-bytes", { status: 200 }));

    expect(await webhook(fetchImpl)).toMatchObject({
      attachmentCount: 3,
      factCount: 3,
      processingStatus: "review",
    });
    expect(state.assets.map((asset) => asset.mime_type)).toEqual([
      "application/pdf",
      "image/jpeg",
      "text/plain",
    ]);
    expect(state.messages[0]?.metadata).toMatchObject({
      rejected_attachment_count: 1,
      rejected_attachments: [
        { filename: "unsafe.pdf", reason: "Lien de téléchargement absent ou non sécurisé" },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("asks Resend to retry a transient attachment failure so its link can be refreshed", async () => {
    const state = fixture();
    receivedEmail({ text: "Pièce jointe à récupérer." });
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "temporary",
            filename: "pv.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "https://example.test/pv.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response("", { status: 503 }));

    await expect(webhook(fetchImpl)).rejects.toThrow("nouvelle tentative");
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: { status: "failed", attempts: 1 },
    });
    expect(state.cases[0]?.status).toBe("sent");
  });

  it("does not create candidates if the case closes during attachment processing", async () => {
    const state = fixture();
    receivedEmail({ text: "Le bien est loué." });
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "late-document",
            filename: "document.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "https://example.test/document.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => {
      state.cases[0]!.status = "completed";
      return new Response("%PDF-1.7\nfixture", { status: 200 });
    });

    expect(await webhook(fetchImpl)).toMatchObject({ factCount: 0, attachmentCount: 0 });
    expect(state.messages[0]?.metadata).toMatchObject({
      processing_ignored_case_status: "completed",
    });
    expect(state.facts).toHaveLength(0);
    expect(state.cases[0]?.status).toBe("completed");
  });

  it("fails closed when the case closes at the final compare-and-set update", async () => {
    const state = fixture({ closeCaseBeforeFinalUpdate: true });
    receivedEmail();
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "cas-race-document",
            filename: "document.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "https://example.test/document.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response("%PDF-1.7\nfixture", { status: 200 }));

    expect(await webhook(fetchImpl)).toMatchObject({
      accepted: true,
      processingStatus: "review",
      factCount: 3,
      attachmentCount: 1,
    });
    expect(state.cases[0]?.status).toBe("completed");
    expect(state.missions[0]?.status).toBe("sent");
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: {
        status: "review",
        reason: "case_closed_during_processing",
      },
    });
    expect(state.assets).toHaveLength(1);
    expect(state.facts).toHaveLength(3);
  });

  it("keeps an unexpected sender for review without creating facts or downloading attachments", async () => {
    const state = fixture();
    receivedEmail({ from: "Other <other@example.test>" });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({
      caseId: CASE_A,
      factCount: 0,
      attachmentCount: 0,
    });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.metadata).toMatchObject({ sender_matches_recipient: false });
    expect(state.cases[0]?.status).toBe("review");
    expect(state.facts).toHaveLength(0);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    receivedEmail({
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
    });
    expect(await webhook(fetchImpl)).toMatchObject({
      duplicate: true,
      processingStatus: "review",
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the actual From address when the display name contains another email", async () => {
    const state = fixture();
    receivedEmail({ from: "Expected contact@example.test <attacker@example.test>" });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({
      caseId: CASE_A,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "review",
    });
    expect(state.cases[0]?.status).toBe("review");
    expect(state.messages[0]?.metadata).toMatchObject({ sender_matches_recipient: false });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("records an authenticated explicit opt-out globally and skips extraction", async () => {
    const state = fixture();
    receivedEmail({
      text: "Bonjour,\nMerci de ne plus me contacter et supprimez mon adresse.\n",
    });
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "must-not-be-downloaded",
            filename: "document.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "https://example.test/document.pdf",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({
      caseId: CASE_A,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "review",
    });
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0]).toMatchObject({
      sale_id: null,
      scope_sale_id: null,
      email: "contact@example.test",
      opposition_status: "opposed",
    });
    expect(state.cases[0]?.status).toBe("review");
    expect(state.cases[0]?.metadata).toMatchObject({ last_inbound_contact_opposed: true });
    expect(state.messages[0]?.metadata).toMatchObject({
      inbound_processing: { status: "review", reason: "contact_opposed" },
    });
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    expect(await webhook(fetchImpl)).toMatchObject({
      duplicate: true,
      processingStatus: "review",
    });
    expect(state.contacts).toHaveLength(1);
  });

  it("keeps an explicit Resend authentication failure in review even in relaxed mode", async () => {
    const state = fixture();
    receivedEmail({
      authentication: { spf: "pass", dkim: "pass", dmarc: "fail" },
    });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({
      caseId: CASE_A,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "review",
    });
    expect(state.messages[0]?.metadata).toMatchObject({
      sender_matches_recipient: true,
      sender_authentication: {
        status: "fail",
        spf: "pass",
        dkim: "pass",
        dmarc: "fail",
      },
      inbound_processing: { status: "review", reason: "sender_authentication_failed" },
    });
    expect(state.cases[0]?.status).toBe("review");
    expect(state.facts).toHaveLength(0);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("requires DMARC and one aligned mechanism in strict mode without requiring both", async () => {
    const state = fixture();
    receivedEmail({
      authentication: { spf: "pass", dkim: "unknown", dmarc: "pass" },
    });

    expect(
      await webhook(vi.fn(), "fixture", {}, false, {
        INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION: "true",
      }),
    ).toMatchObject({ caseId: CASE_A, factCount: 2, processingStatus: "review" });
    expect(state.messages[0]?.metadata).toMatchObject({
      sender_authentication: {
        status: "pass",
        spf: "pass",
        dkim: "unknown",
        dmarc: "pass",
      },
    });
    expect(state.facts).toHaveLength(2);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["SPF", { spf: "fail", dkim: "pass", dmarc: "pass" }],
    ["DKIM", { spf: "pass", dkim: "fail", dmarc: "pass" }],
  ] as const)(
    "admits a DMARC pass through the other aligned mechanism when %s fails",
    async (_mechanism, authentication) => {
      const state = fixture();
      receivedEmail({ authentication });

      expect(
        await webhook(vi.fn(), "fixture", {}, false, {
          INFORMATION_AGENT_REQUIRE_EMAIL_AUTHENTICATION: "true",
        }),
      ).toMatchObject({ caseId: CASE_A, factCount: 2, processingStatus: "review" });
      expect(state.messages[0]?.metadata).toMatchObject({
        sender_authentication: { status: "pass", ...authentication },
      });
      expect(state.facts).toHaveLength(2);
      expect(mocks.list).toHaveBeenCalledTimes(1);
    },
  );

  it("reviews missing authentication by default before extraction", async () => {
    const state = fixture();
    receivedEmail({ authentication: null });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({
      caseId: CASE_A,
      factCount: 0,
      attachmentCount: 0,
      processingStatus: "review",
    });
    expect(state.messages[0]?.metadata).toMatchObject({
      sender_authentication: {
        status: "unverified",
        spf: "missing",
        dkim: "missing",
        dmarc: "missing",
      },
      inbound_processing: { status: "review", reason: "sender_authentication_unverified" },
    });
    expect(state.cases[0]?.status).toBe("review");
    expect(state.facts).toHaveLength(0);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("ignores a message addressed to two case tokens", async () => {
    const state = fixture();
    receivedEmail();
    mocks.verify.mockReturnValue({
      type: "email.received",
      data: {
        email_id: "provider-email-1",
        to: [address(TOKEN_A), address(TOKEN_B)],
        received_for: [],
      },
    });

    expect(await webhook()).toMatchObject({ accepted: true, ignored: true });
    expect(state.messages).toHaveLength(0);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("ignores a provider event whose fetched message names a second case", async () => {
    const state = fixture();
    receivedEmail();
    mocks.get.mockResolvedValue({
      data: {
        from: "Contact <contact@example.test>",
        to: [address(TOKEN_A), address(TOKEN_B)],
        subject: "Re: Ventes A et B",
        text: "Surface habitable 84 m²",
        html: null,
        created_at: "2026-09-23T10:00:00.000Z",
      },
      error: null,
    });

    expect(await webhook()).toMatchObject({ accepted: true, ignored: true });
    expect(state.messages).toHaveLength(0);
  });

  it("refuses to reuse a provider message already assigned to another case", async () => {
    const state = fixture();
    receivedEmail();
    await webhook();

    receivedEmail({ token: TOKEN_B });
    mocks.get.mockResolvedValue({
      data: {
        from: "Contact <contact@example.test>",
        to: [],
        subject: "Re: Vente B",
        text: "Surface habitable 90 m²",
        html: null,
        created_at: "2026-09-23T10:01:00.000Z",
      },
      error: null,
    });

    await expect(webhook()).rejects.toThrow("autre dossier");
    expect(state.messages).toHaveLength(1);
    expect(state.facts.every((fact) => fact.sale_id === SALE_A)).toBe(true);
    expect(state.cases[1]?.status).toBe("sent");
  });

  it("retries after a storage failure without duplicating the inbound message", async () => {
    const state = fixture();
    receivedEmail();
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "attachment-retry",
            filename: "annexe.pdf",
            content_type: "application/pdf",
            size: 16,
            download_url: "https://example.test/annexe.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const upload = vi
      .fn()
      .mockResolvedValueOnce({ error: { message: "Storage unavailable" } })
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null });
    mocks.storageFrom.mockReturnValue({ upload });
    const fetchImpl = vi.fn(async () => new Response("%PDF-1.7\nfixture", { status: 200 }));

    await expect(webhook(fetchImpl)).rejects.toMatchObject({ message: "Storage unavailable" });
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(0);

    expect(await webhook(fetchImpl)).toMatchObject({ caseId: CASE_A, attachmentCount: 1 });
    expect(state.messages).toHaveLength(1);
    expect(state.assets).toHaveLength(1);
    expect(state.facts).toHaveLength(3);
  });

  it("records unsupported attachments instead of silently losing them", async () => {
    const state = fixture();
    receivedEmail({ text: "Je vous transmets le document demandé." });
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "attachment-docx",
            filename: "cahier.docx",
            content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size: 2048,
            download_url: "https://example.test/cahier.docx",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn();

    expect(await webhook(fetchImpl)).toMatchObject({ caseId: CASE_A, attachmentCount: 0 });
    expect(state.messages[0]?.metadata).toMatchObject({
      rejected_attachments: [{ filename: "cahier.docx", reason: "Format non pris en charge" }],
    });
    expect(state.cases[0]?.status).toBe("review");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes a PDF MIME parameter and reports an oversized attachment", async () => {
    const state = fixture();
    receivedEmail({ text: "Documents en pièce jointe." });
    mocks.list.mockResolvedValue({
      data: {
        data: [
          {
            id: "attachment-pdf",
            filename: "pv.pdf",
            content_type: "APPLICATION/PDF; name=pv.pdf",
            size: 16,
            download_url: "https://example.test/pv.pdf",
            content_disposition: "attachment",
          },
          {
            id: "attachment-huge",
            filename: "archive.pdf",
            content_type: "application/pdf",
            size: 21 * 1024 * 1024,
            download_url: "https://example.test/archive.pdf",
            content_disposition: "attachment",
          },
        ],
      },
      error: null,
    });
    const fetchImpl = vi.fn(async () => new Response("%PDF-1.7\nfixture", { status: 200 }));

    expect(await webhook(fetchImpl)).toMatchObject({ attachmentCount: 1 });
    expect(state.assets[0]?.mime_type).toBe("application/pdf");
    expect(state.messages[0]?.metadata).toMatchObject({
      rejected_attachment_count: 1,
      rejected_attachments: [{ filename: "archive.pdf", reason: "Taille hors limite" }],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not turn quoted request text into a new fact", async () => {
    const state = fixture();
    receivedEmail({
      text: "Je vérifie et reviens vers vous.\n\nLe 20 septembre, ImmoJudis a écrit :\n> Surface 84 m² et 4 pièces",
    });

    expect(await webhook()).toMatchObject({ factCount: 0 });
    expect(state.messages).toHaveLength(1);
    expect(state.facts).toHaveLength(0);
  });

  it("ignores replies to a draft that was never sent", async () => {
    const state = fixture();
    state.cases[0]!.status = "draft";
    receivedEmail();

    expect(await webhook()).toMatchObject({ accepted: true, ignored: true });
    expect(state.messages).toHaveLength(0);
  });
});
