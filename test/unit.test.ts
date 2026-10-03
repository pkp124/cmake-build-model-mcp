import { describe, expect, it } from "vitest";
import { parseCMakeCacheTxt } from "../src/cmake/cache.js";
import { entryMatches, splitCommand } from "../src/compileCommands.js";
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

describe("splitCommand", () => {
  it("splits POSIX shell command lines", () => {
    expect(splitCommand(`/usr/bin/c++ -DA=1 -DMSG=\\"hi\\ there\\" '-I/a b' "-DQ=\\"x\\"" -c f.cpp`, "linux")).toEqual([
      "/usr/bin/c++",
      "-DA=1",
      '-DMSG="hi there"',
      "-I/a b",
      '-DQ="x"',
      "-c",
      "f.cpp",
    ]);
  });

  it("splits Windows command lines", () => {
    expect(splitCommand(`C:\\cl.exe /nologo "-IC:\\a b\\inc" -DMSG=\\"hi\\" /c C:\\src\\f.cpp`, "win32")).toEqual([
      "C:\\cl.exe",
      "/nologo",
      "-IC:\\a b\\inc",
      '-DMSG="hi"',
      "/c",
      "C:\\src\\f.cpp",
    ]);
  });
});

describe("entryMatches", () => {
  const entry = (output?: string) => ({ file: "/s/a.c", directory: "/b", arguments: [], output });
  it("attributes entries to targets and configurations via the object path", () => {
    expect(entryMatches(entry("tools/CMakeFiles/app.dir/main.cpp.o"), "app")).toBe(true);
    expect(entryMatches(entry("CMakeFiles/app.dir/main.cpp.o"), "app")).toBe(true);
    expect(entryMatches(entry("CMakeFiles/app2.dir/main.cpp.o"), "app")).toBe(false);
    expect(entryMatches(entry("CMakeFiles/app.dir/Debug/main.cpp.o"), "app", "Debug")).toBe(true);
    expect(entryMatches(entry("CMakeFiles/app.dir/Release/main.cpp.o"), "app", "Debug")).toBe(false);
    expect(entryMatches(entry(undefined), "app", "Debug")).toBe(true);
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
