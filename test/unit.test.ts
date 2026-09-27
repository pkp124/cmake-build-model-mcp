import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseCMakeCacheTxt } from "../src/cmake/cache.js";
import { loadPresets } from "../src/cmake/presets.js";
import { globOrRegex, isWithin } from "../src/model.js";

describe("parseCMakeCacheTxt", () => {
  it("parses typed, untyped and quoted entries while skipping comments", () => {
    const entries = parseCMakeCacheTxt(
      [
        "# comment",
        "//help text",
        "CMAKE_BUILD_TYPE:STRING=Debug",
        "CMAKE_HOME_DIRECTORY:INTERNAL=/src/app",
        '"WEIRD:NAME":BOOL=ON',
        "NO_TYPE=value=with=equals",
        "",
      ].join("\n"),
    );
    expect(entries.get("CMAKE_BUILD_TYPE")).toEqual({ name: "CMAKE_BUILD_TYPE", type: "STRING", value: "Debug" });
    expect(entries.get("CMAKE_HOME_DIRECTORY")?.value).toBe("/src/app");
    expect(entries.get("WEIRD:NAME")?.value).toBe("ON");
    expect(entries.get("NO_TYPE")).toEqual({ name: "NO_TYPE", type: "UNINITIALIZED", value: "value=with=equals" });
  });
});

describe("globOrRegex", () => {
  it("supports substrings, globs and slash-delimited regexes", () => {
    expect(globOrRegex("core").test("libcore_x")).toBe(true);
    expect(globOrRegex("app_*").test("app_cli")).toBe(true);
    expect(globOrRegex("app_*").test("my_app_cli")).toBe(false);
    expect(globOrRegex("/^c.re$/").test("core")).toBe(true);
    expect(globOrRegex("a.b").test("axb")).toBe(false);
  });
});

describe("isWithin", () => {
  it("detects containment without prefix confusion", () => {
    expect(isWithin("/a/b/c.cpp", "/a/b")).toBe(true);
    expect(isWithin("/a/b", "/a/b")).toBe(true);
    expect(isWithin("/a/bc/d.cpp", "/a/b")).toBe(false);
  });
});

describe("loadPresets", () => {
  it("resolves inheritance, macros, includes and hides hidden presets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "presets-"));
    await writeFile(
      path.join(dir, "CMakePresets.json"),
      JSON.stringify({
        version: 4,
        include: ["more.json"],
        configurePresets: [
          { name: "base", hidden: true, binaryDir: "${sourceDir}/out/${presetName}", cacheVariables: { A: "1", B: "1" } },
          { name: "dev", inherits: "base", cacheVariables: { B: "2" } },
          { name: "rel", inherits: ["base"], binaryDir: "build-rel" },
        ],
        buildPresets: [{ name: "dev", configurePreset: "dev", targets: "all" }],
      }),
    );
    await writeFile(
      path.join(dir, "more.json"),
      JSON.stringify({ version: 4, configurePresets: [{ name: "extra", binaryDir: "${fileDir}/x" }] }),
    );
    const presets = await loadPresets(dir);
    const byName = Object.fromEntries(presets.configurePresets.map((p) => [p.name, p]));
    expect(Object.keys(byName).sort()).toEqual(["dev", "extra", "rel"]);
    expect(byName.dev.binaryDir).toBe(path.join(dir, "out", "dev"));
    expect(byName.dev.cacheVariables).toEqual({ A: "1", B: "2" });
    expect(byName.rel.binaryDir).toBe(path.join(dir, "build-rel"));
    expect(byName.extra.binaryDir).toBe(path.join(dir, "x"));
    expect(presets.buildPresets).toEqual([
      expect.objectContaining({ name: "dev", configurePreset: "dev", targets: ["all"] }),
    ]);
    expect(presets.errors).toEqual([]);
  });
});
