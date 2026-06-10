#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const viteBin = join(root, "node_modules", ".bin", "vite");

const args = new Map();
const repeatedArgs = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (!item.startsWith("--")) continue;
  const [rawKey, inlineValue] = item.slice(2).split("=", 2);
  const next = process.argv[index + 1];
  const value = inlineValue ?? (next && !next.startsWith("--") ? next : "true");
  if (inlineValue === undefined && next && !next.startsWith("--")) {
    index += 1;
  }
  args.set(rawKey, value);
  repeatedArgs.set(rawKey, [...(repeatedArgs.get(rawKey) ?? []), value]);
}

const host = args.get("host") ?? "127.0.0.1";
const port = Number(args.get("port") ?? process.env.PORT ?? 5173);
const timeoutMs = Number(args.get("timeout") ?? 120_000);
const requestTimeoutMs = Number(args.get("request-timeout") ?? 8_000);
const baseUrl = `http://${host}:${port}`;
const probes = ["/@vite/client", "/", ...normalizeWarmPaths(repeatedArgs.get("warm-path") ?? [])];

if (!existsSync(viteBin)) {
  console.error("[dev-ready] node_modules is missing. Install dependencies before starting Vite.");
  process.exit(1);
}

const child = spawn(viteBin, ["--host", host, "--port", String(port), "--strictPort"], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => process.stderr.write(chunk));

let childExited = false;
let childExitCode = 0;
child.on("exit", (code, signal) => {
  childExited = true;
  childExitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
  if (code && code !== 0) {
    console.error(`[dev-ready] Vite exited with code ${code}${signal ? ` (${signal})` : ""}.`);
  }
  process.exitCode = childExitCode;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(signal === "SIGINT" ? 130 : 143);
  });
}

const deadline = Date.now() + timeoutMs;
try {
  await waitForServer();
  console.log(`\n[dev-ready] Serveur local pret: ${baseUrl}`);
  console.log("[dev-ready] Routes verifiees: " + probes.join(", "));
} catch (error) {
  child.kill("SIGTERM");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWarmPaths(paths) {
  return paths
    .map((path) => normalize(path).replaceAll("\\", "/"))
    .map((path) => (path.startsWith("/") ? path : `/${path}`))
    .filter((path, index, values) => values.indexOf(path) === index);
}

async function waitForServer() {
  let lastError = "not started";
  while (Date.now() < deadline) {
    if (childExited) {
      throw new Error(
        `[dev-ready] Vite stopped before the server became ready (exit ${childExitCode}).`,
      );
    }
    try {
      for (const path of probes) {
        await probe(path);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(750);
    }
  }

  child.kill("SIGTERM");
  throw new Error(
    `[dev-ready] Timed out after ${timeoutMs}ms waiting for ${baseUrl}: ${lastError}`,
  );
}

async function probe(path) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: path === "/@vite/client" ? "text/javascript" : "text/html" },
    });
    if (response.status >= 400) {
      throw new Error(`${path} returned ${response.status}`);
    }
    await response.arrayBuffer();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${path} did not answer within ${requestTimeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
