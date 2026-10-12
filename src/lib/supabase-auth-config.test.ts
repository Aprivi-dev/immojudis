import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const config = readFileSync(join(process.cwd(), "supabase/config.toml"), "utf8");

function section(name: string): string {
  const start = config.indexOf(`[${name}]`);
  expect(start, `[${name}] section`).toBeGreaterThanOrEqual(0);
  const rest = config.slice(start + name.length + 2);
  const next = rest.search(/^\[/m);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("versioned Supabase Auth configuration", () => {
  it("requires passwords of at least 12 characters", () => {
    expect(section("auth")).toMatch(/^minimum_password_length\s*=\s*(\d+)/m);
    const length = Number(/^minimum_password_length\s*=\s*(\d+)/m.exec(section("auth"))?.[1]);
    expect(length).toBeGreaterThanOrEqual(12);
  });

  it("requires email confirmation", () => {
    expect(section("auth.email")).toMatch(/^enable_confirmations\s*=\s*true/m);
    expect(section("auth.email")).toMatch(/^double_confirm_changes\s*=\s*true/m);
  });

  it("limits redirects to the production origin", () => {
    const auth = section("auth");
    expect(auth).toMatch(/^site_url\s*=\s*"https:\/\/immojudis\.com"/m);
    const redirects = /^additional_redirect_urls\s*=\s*\[([^\]]*)\]/m.exec(auth)?.[1] ?? "";
    expect(redirects.match(/"[^"]+"/g)).toEqual(['"https://immojudis.com/**"']);
    expect(auth).not.toMatch(/localhost|127\.0\.0\.1|\*\*\*/);
  });

  it("enables the TOTP factor used by the administrator MFA", () => {
    const totp = section("auth.mfa.totp");
    expect(totp).toMatch(/^enroll_enabled\s*=\s*true/m);
    expect(totp).toMatch(/^verify_enabled\s*=\s*true/m);
  });

  it("keeps anonymous sign-ins off and refresh-token rotation on", () => {
    expect(section("auth")).toMatch(/^enable_anonymous_sign_ins\s*=\s*false/m);
    expect(section("auth")).toMatch(/^enable_refresh_token_rotation\s*=\s*true/m);
  });
});
