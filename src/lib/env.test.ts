import { afterEach, describe, expect, it, vi } from "vitest";
import { firstFilled, publicEnv, serverEnv } from "@/lib/env";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("firstFilled", () => {
  it("returns the first non-blank value, trimmed", () => {
    expect(firstFilled(undefined, "   ", "\t", " b ", "c")).toBe("b");
    expect(firstFilled(undefined, "")).toBeUndefined();
    expect(firstFilled()).toBeUndefined();
  });
});

describe("publicEnv", () => {
  it("reads the canonical NEXT_PUBLIC names", () => {
    expect(
      publicEnv({
        NEXT_PUBLIC_SUPABASE_URL: " https://x.supabase.co ",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pub",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      }),
    ).toEqual({ supabaseUrl: "https://x.supabase.co", supabasePublishableKey: "pub" });
  });

  it("falls back to the legacy anon key, and ignores blank values", () => {
    expect(
      publicEnv({
        NEXT_PUBLIC_SUPABASE_URL: "  ",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      }),
    ).toEqual({ supabaseUrl: undefined, supabasePublishableKey: "anon" });
  });

  it("never reads server-only or VITE_ names in browser code", () => {
    expect(
      publicEnv({
        SUPABASE_URL: "https://server.example",
        SUPABASE_SERVICE_ROLE_KEY: "secret",
        VITE_SUPABASE_URL: "https://vite.example",
        VITE_SUPABASE_PUBLISHABLE_KEY: "vite-key",
      }),
    ).toEqual({ supabaseUrl: undefined, supabasePublishableKey: undefined });
  });

  it("reads process.env statically when no source is given", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proc.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "proc-key");
    expect(publicEnv()).toEqual({
      supabaseUrl: "https://proc.supabase.co",
      supabasePublishableKey: "proc-key",
    });
  });
});

describe("serverEnv supabase chains", () => {
  it("keeps the historical order of the anonymous server client", () => {
    expect(
      serverEnv({
        NEXT_PUBLIC_SUPABASE_URL: "https://public.example",
        SUPABASE_URL: "https://server.example",
        VITE_SUPABASE_URL: "https://vite.example",
        NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pub",
        NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
        VITE_SUPABASE_PUBLISHABLE_KEY: "vite",
      }).supabase,
    ).toMatchObject({ publicUrl: "https://public.example", publishableKey: "pub" });

    expect(serverEnv({ SUPABASE_URL: "https://server.example" }).supabase.publicUrl).toBe(
      "https://server.example",
    );
    expect(serverEnv({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }).supabase.publishableKey).toBe(
      "anon",
    );
  });

  it("prefers SUPABASE_URL for the service-role client", () => {
    const supabase = serverEnv({
      SUPABASE_URL: "https://server.example",
      NEXT_PUBLIC_SUPABASE_URL: "https://public.example",
      SUPABASE_SECRET_KEY: "secret",
    }).supabase;
    expect(supabase.adminUrl).toBe("https://server.example");
    expect(supabase.serviceRoleKey).toBe("secret");
    expect(
      serverEnv({ SUPABASE_SERVICE_ROLE_KEY: "legacy", SUPABASE_SECRET_KEY: "new" }).supabase
        .serviceRoleKey,
    ).toBe("legacy");
  });

  it("keeps the deprecated VITE_ variables as the last fallback (production still uses them)", () => {
    const supabase = serverEnv({
      VITE_SUPABASE_URL: "https://vite.supabase.co",
      VITE_SUPABASE_PUBLISHABLE_KEY: "vite-key",
    }).supabase;
    expect(supabase.publicUrl).toBe("https://vite.supabase.co");
    expect(supabase.adminUrl).toBe("https://vite.supabase.co");
    expect(supabase.publishableKey).toBe("vite-key");
  });

  it("falls back to the database URL aliases in order", () => {
    expect(
      serverEnv({ POSTGRES_URL: "c", POSTGRES_URL_NON_POOLING: "b" }).supabase.databaseUrl,
    ).toBe("b");
    expect(serverEnv({ SUPABASE_DB_URL: " a ", POSTGRES_URL: "c" }).supabase.databaseUrl).toBe("a");
    expect(serverEnv({}).supabase.databaseUrl).toBeUndefined();
  });

  it("reads process.env when no source is given", () => {
    vi.stubEnv("SUPABASE_URL", "https://proc-server.example");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "proc-secret");
    const supabase = serverEnv().supabase;
    expect(supabase.adminUrl).toBe("https://proc-server.example");
    expect(supabase.serviceRoleKey).toBe("proc-secret");
  });
});

describe("serverEnv pipeline, alerts and email", () => {
  it("applies the pipeline defaults and the token fallback order", () => {
    expect(serverEnv({}).pipeline).toEqual({
      githubToken: undefined,
      repository: "Aprivi-dev/immojudis",
      workflow: "data-pipeline.yml",
      ref: "main",
      webhookUrl: undefined,
      webhookSecret: undefined,
    });
    expect(
      serverEnv({
        GITHUB_ACTIONS_DISPATCH_TOKEN: "third",
        IMMOJUDIS_GITHUB_ACTIONS_TOKEN: "second",
        GITHUB_SCROLL_REPOSITORY: "org/repo",
        GITHUB_SCROLL_WORKFLOW: "wf.yml",
        GITHUB_SCROLL_REF: "release",
        IMMOJUDIS_SCROLL_WEBHOOK_URL: "https://hook.example",
        SCROLL_WEBHOOK_SECRET: "s",
      }).pipeline,
    ).toEqual({
      githubToken: "second",
      repository: "org/repo",
      workflow: "wf.yml",
      ref: "release",
      webhookUrl: "https://hook.example",
      webhookSecret: "s",
    });
  });

  it("falls back from the operational alert variables to the pipeline ones", () => {
    expect(
      serverEnv({ GITHUB_SCROLL_REPOSITORY: "org/pipeline", GITHUB_SCROLL_REF: "dev" }).alerts,
    ).toMatchObject({
      githubRepository: "org/pipeline",
      githubWorkflow: "operational-alert.yml",
      githubRef: "dev",
      environment: "unknown",
    });
    expect(
      serverEnv({
        OPERATIONS_ALERT_GITHUB_REPOSITORY: "org/alerts",
        GITHUB_SCROLL_REPOSITORY: "org/pipeline",
        OPERATIONS_ALERT_GITHUB_REF: "alert-ref",
        VERCEL_ENV: "preview",
        NODE_ENV: "production",
      }).alerts,
    ).toMatchObject({
      githubRepository: "org/alerts",
      githubRef: "alert-ref",
      environment: "preview",
    });
  });

  it("reads the email sender with its RESEND_FROM_EMAIL fallback", () => {
    expect(serverEnv({ RESEND_API_KEY: " re_x ", RESEND_FROM_EMAIL: "from@x.test" }).email).toEqual(
      { resendApiKey: "re_x", from: "from@x.test" },
    );
    expect(
      serverEnv({ ALERT_EMAIL_FROM: "alert@x.test", RESEND_FROM_EMAIL: "from@x.test" }).email.from,
    ).toBe("alert@x.test");
  });

  it("treats whitespace-only secrets as unset", () => {
    const env = serverEnv({
      STRIPE_SECRET_KEY: "   ",
      STRIPE_WEBHOOK_SECRET: "\t",
      CRON_SECRET: "\n",
    });
    expect(env.stripe).toEqual({ secretKey: undefined, webhookSecret: undefined });
    expect(env.cronSecret).toBeUndefined();
  });
});
