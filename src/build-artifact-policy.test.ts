import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readPackageManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(PACKAGE_ROOT, "package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(exportTargets);
  }
  return [];
}

describe("build artifact policy", () => {
  it("keeps every package entrypoint source-backed", () => {
    const manifest = readPackageManifest();
    const entrypoints = [manifest.main, manifest.types, ...exportTargets(manifest.exports)];

    expect(entrypoints.length).toBeGreaterThan(0);
    for (const entrypoint of entrypoints) {
      if (typeof entrypoint !== "string") throw new Error("package entrypoint must be a string");
      expect(entrypoint.startsWith("./src/")).toBe(true);
      expect(entrypoint.includes("/dist/")).toBe(false);
    }
  });

  it("keeps generated dist output ignored and untracked", () => {
    const ignoreRules = readFileSync(resolve(PACKAGE_ROOT, ".gitignore"), "utf8").split(/\r?\n/);
    const trackedDist = execFileSync("git", ["ls-files", "--", "dist"], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    const deletedDist = new Set(
      execFileSync("git", ["ls-files", "--deleted", "--", "dist"], {
        cwd: PACKAGE_ROOT,
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/)
        .filter(Boolean),
    );

    expect(ignoreRules).toContain("dist/");
    expect(() =>
      execFileSync("git", ["check-ignore", "--no-index", "--quiet", "--", "dist/sentinel.js"], {
        cwd: PACKAGE_ROOT,
        stdio: "ignore",
      }),
    ).not.toThrow();
    expect(trackedDist.filter((path) => !deletedDist.has(path))).toEqual([]);
  });
});
