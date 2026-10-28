import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { checkVersions } from "./check-versions.mjs";

const REPOSITORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directories = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const CI = `jobs:
  typecheck:
    steps:
      - uses: actions/setup-node@x
        with:
          node-version-file: .node-version
      - run: npm install --global npm@11.18.0
  e2e:
    container:
      image: mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
`;

/** Un dépôt minimal et cohérent, dont `overrides` remplace des fichiers. */
async function fixture(overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-versions-"));
  directories.push(root);
  const files = {
    ".nvmrc": "24.15.0\n",
    ".node-version": "24.15.0\n",
    "package.json": JSON.stringify({
      engines: { node: ">=24.15.0 <25", npm: ">=11.18.0 <12" },
      devDependencies: { "@playwright/test": "1.64.1" },
    }),
    "package-lock.json": JSON.stringify({
      packages: { "node_modules/@playwright/test": { version: "1.64.1" } },
    }),
    "vercel.json": JSON.stringify({
      installCommand: "npx --yes --package=npm@11.18.0 -c 'npm ci'",
    }),
    ".github/workflows/ci.yml": CI,
    ".github/workflows/other.yml": "steps:\n  - run: npm install --global npm@11.18.0\n",
    ...overrides,
  };
  for (const [relativePath, content] of Object.entries(files)) {
    if (content === null) continue;
    const file = path.join(root, relativePath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return root;
}

describe("check-versions", () => {
  it("le dépôt lui-même est cohérent (Node, npm, image Playwright)", async () => {
    expect(await checkVersions({ root: REPOSITORY })).toEqual([]);
  });

  it("un dépôt cohérent ne donne aucun problème", async () => {
    expect(await checkVersions({ root: await fixture() })).toEqual([]);
  });

  it("v24.15.0 dans .nvmrc vaut 24.15.0", async () => {
    const root = await fixture({ ".nvmrc": "v24.15.0\n" });
    expect(await checkVersions({ root })).toEqual([]);
  });

  it("signale .node-version différent de .nvmrc", async () => {
    const root = await fixture({ ".node-version": "24.16.0\n" });
    expect(await checkVersions({ root })).toEqual([
      ".node-version (24.16.0) et .nvmrc (24.15.0) diffèrent.",
    ]);
  });

  it("signale une borne de engines.node qui ne suit pas .nvmrc, ou une borne haute fausse", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        engines: { node: ">=24.14.0 <26", npm: ">=11.18.0 <12" },
        devDependencies: { "@playwright/test": "1.64.1" },
      }),
    });
    const problems = await checkVersions({ root });
    expect(problems).toContain(
      "package.json engines.node commence à 24.14.0 mais .nvmrc épingle 24.15.0.",
    );
    expect(problems).toContain(
      "package.json engines.node s'arrête à la version majeure 26 au lieu de 25.",
    );
  });

  it("signale un npm épinglé différemment dans un workflow ou dans vercel.json", async () => {
    const root = await fixture({
      ".github/workflows/other.yml": "steps:\n  - run: npm install --global npm@11.17.0\n",
      "vercel.json": JSON.stringify({
        installCommand: "npx --yes --package=npm@11.19.0 -c 'npm ci'",
      }),
    });
    const problems = await checkVersions({ root });
    expect(problems).toContain(
      "other.yml épingle npm@11.17.0 alors que engines.npm commence à 11.18.0.",
    );
    expect(problems).toContain(
      "vercel.json installCommand épingle npm@11.19.0 alors que engines.npm commence à 11.18.0.",
    );
  });

  it("signale un node-version écrit en clair qui diffère de .nvmrc", async () => {
    const root = await fixture({
      ".github/workflows/other.yml":
        "steps:\n  - uses: actions/setup-node@x\n    with:\n      node-version: 22\n  - run: npm install --global npm@11.18.0\n",
    });
    expect(await checkVersions({ root })).toEqual([
      "other.yml épingle node-version 22 alors que .nvmrc épingle 24.15.0.",
    ]);
  });

  it("signale une image Playwright différente de @playwright/test (montée par Dependabot)", async () => {
    const root = await fixture({
      "package.json": JSON.stringify({
        engines: { node: ">=24.15.0 <25", npm: ">=11.18.0 <12" },
        devDependencies: { "@playwright/test": "1.65.0" },
      }),
      "package-lock.json": JSON.stringify({
        packages: { "node_modules/@playwright/test": { version: "1.65.0" } },
      }),
    });
    expect(await checkVersions({ root })).toEqual([
      "ci.yml lance e2e dans l'image Playwright v1.64.1 alors que @playwright/test vaut 1.65.0 : monter l'image (étiquette et empreinte) avec le paquet.",
    ]);
  });

  it("signale un lockfile qui n'installe pas la version de package.json", async () => {
    const root = await fixture({
      "package-lock.json": JSON.stringify({
        packages: { "node_modules/@playwright/test": { version: "1.63.0" } },
      }),
    });
    expect(await checkVersions({ root })).toEqual([
      "package-lock.json installe @playwright/test 1.63.0 alors que package.json demande 1.64.1.",
    ]);
  });

  it("signale un ci.yml qui n'utilise plus l'image officielle", async () => {
    const root = await fixture({ ".github/workflows/ci.yml": "jobs: {}\n" });
    expect(await checkVersions({ root })).toContain(
      "ci.yml ne lance plus e2e dans l'image mcr.microsoft.com/playwright:vX.Y.Z.",
    );
  });
});
