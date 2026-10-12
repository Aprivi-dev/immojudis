import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src/app/api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

/**
 * Extracts the balanced-parenthesis argument text of every `NextResponse.json(` or
 * `Response.json(` call so a response body can be inspected on its own.
 */
function responseJsonCalls(source: string): string[] {
  const calls: string[] = [];
  const opener = /(?:NextResponse|Response)\.json\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source))) {
    let depth = 1;
    let index = match.index + match[0].length;
    const start = index;
    while (index < source.length && depth > 0) {
      const char = source[index++];
      if (char === "(") depth++;
      else if (char === ")") depth--;
    }
    calls.push(source.slice(start, index - 1));
  }
  return calls;
}

const files = routeFiles(API_ROOT).map((path) => ({
  path: relative(process.cwd(), path),
  source: readFileSync(path, "utf8"),
}));

describe("API routes never return internal error messages", () => {
  it("scans a meaningful number of route handlers", () => {
    expect(files.length).toBeGreaterThan(60);
  });

  it("does not read the message of a caught error inside a route handler", () => {
    const offenders = files
      .filter(({ source }) => /(?<![.\w])(error|err|cause|exception)\.message\b/.test(source))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("does not build an error response body from a message or error variable", () => {
    const offenders = files
      .filter(({ source }) =>
        responseJsonCalls(source).some((call) =>
          /\b(?:error|detail|details|reason)\s*:\s*(?:message|error|err|String\(|e\b|\w+\.message)/.test(
            call,
          ),
        ),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("does not stringify a caught error into a response", () => {
    const offenders = files
      .filter(({ source }) =>
        responseJsonCalls(source).some((call) =>
          /String\(error\)|\$\{error\}|JSON\.stringify\(error\)/.test(call),
        ),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
