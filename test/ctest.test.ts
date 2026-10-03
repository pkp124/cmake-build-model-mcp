import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { splitCmakeList, unescapeCmakeQuoted } from "../src/ctest/cmake.js";
import { ctestRegex } from "../src/ctest/regex.js";
import { locateTestXml, readTestResult, TestRun } from "../src/ctest/results.js";
import { selectTests } from "../src/ctest/select.js";
import { TestIndex, type CTestTest } from "../src/ctest/testfile.js";
import { tokenizeBuffers } from "../src/ctest/xml.js";

describe("cmake lists", () => {
  it("keeps escaped semicolons inside one element", () => {
    const quoted = unescapeCmakeQuoted(String.raw`FOO=bar;BAZ=a\\;b`);
    expect(quoted).toBe(String.raw`FOO=bar;BAZ=a\;b`);
    expect(splitCmakeList(quoted)).toEqual(["FOO=bar", "BAZ=a;b"]);
  });
});

describe("ctest regex", () => {
  it("is an unanchored case-sensitive search and treats braces as literal", () => {
    expect(ctestRegex("plain").test("my_plain_test")).toBe(true);
    expect(ctestRegex("^plain$").test("plain")).toBe(true);
    expect(ctestRegex("^plain$").test("plain_extra")).toBe(false);
    expect(ctestRegex("P").test("plain")).toBe(false);
    expect(ctestRegex("pl{2}").test("pll")).toBe(false);
    expect(ctestRegex("pl{2}").test("pl{2}")).toBe(true);
    expect(ctestRegex("p[a-z]+n$").test("plain")).toBe(true);
  });

  it("rejects javascript-only syntax", () => {
    expect(() => ctestRegex("\\d")).toThrow(/not special/);
    expect(() => ctestRegex("a(?=b)")).toThrow(/does not support/);
    expect(() => ctestRegex("pla*?")).toThrow(/lazy/);
    expect(() => ctestRegex("[")).toThrow(/Invalid test regex/);
  });
});

describe("CTestTestfile parser", () => {
  it("reads bracket arguments, directory labels, fixtures, and config gates", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ctest-parse-"));
    const nested = path.join(root, "nested");
    await mkdir(nested);
    await writeFile(
      path.join(root, "CTestTestfile.cmake"),
      [
        "# Source directory: /src",
        "# Build directory: /build",
        'add_test([=[a b]=] "/bin/echo" "a;b" "c d")',
        'set_tests_properties([=[a b]=] PROPERTIES LABELS "unit;fast" ENVIRONMENT "FOO=bar;BAZ=a\\\\;b" DEPENDS "other" FIXTURES_REQUIRED "db" TIMEOUT "30" DISABLED "OFF" _BACKTRACE_TRIPLES "/src/CMakeLists.txt;4;add_test;/src/CMakeLists.txt;0;")',
        'add_test(setup "/bin/true")',
        'set_tests_properties(setup PROPERTIES FIXTURES_SETUP "db" DISABLED "TRUE")',
        'add_test(cleanup "/bin/true")',
        'set_tests_properties(cleanup PROPERTIES FIXTURES_CLEANUP "db")',
        'if(CTEST_CONFIGURATION_TYPE MATCHES "^([Dd][Ee][Bb][Uu][Gg])$")',
        '  add_test(cfg "/bin/echo" "debug")',
        "endif()",
        'if(CTEST_CONFIGURATION_TYPE MATCHES "^([Rr][Ee][Ll][Ee][Aa][Ss][Ee])$")',
        '  add_test(cfg "/bin/echo" "release")',
        "else()",
        '  add_test(cfg_else "/bin/true")',
        "endif()",
        'subdirs("nested")',
        'set_directory_properties(PROPERTIES LABELS "dir")',
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(nested, "CTestTestfile.cmake"),
      ['# Source directory: /src/nested', '# Build directory: /build/nested', 'add_test(child "/bin/true")', ""].join("\n"),
    );

    const index = await TestIndex.load(root);
    const debug = index!.testsFor("Debug").map((test) => test.name);
    expect(debug).toEqual(["a b", "setup", "cleanup", "cfg", "cfg_else", "child"]);
    const release = index!.testsFor("Release").map((test) => test.name);
    expect(release).toEqual(["a b", "setup", "cleanup", "cfg", "child"]);

    const spaced = index!.get("a b", "Debug");
    expect(spaced.command).toEqual(["/bin/echo", "a;b", "c d"]);
    expect(spaced.labels).toEqual(["dir", "unit", "fast"]);
    expect(spaced.environment).toEqual(["FOO=bar", "BAZ=a;b"]);
    expect(spaced.depends).toEqual(["other"]);
    expect(spaced.fixtures.required).toEqual(["db"]);
    expect(spaced.timeout).toBe(30);
    expect(spaced.disabled).toBe(false);
    expect(spaced.backtrace).toEqual([{ file: "/src/CMakeLists.txt", line: 4, command: "add_test" }]);
    expect(index!.get("setup", "Debug").disabled).toBe(true);
    expect(index!.get("cfg", "Debug").command).toEqual(["/bin/echo", "debug"]);
    expect(index!.get("cfg", "Release").command).toEqual(["/bin/echo", "release"]);
    expect(index!.get("child", "Debug").workingDirectory).toBe("/build/nested");
    expect(index!.get("child", "Debug").labels).toEqual([]);

    const preview = selectTests(index!.testsFor("Debug"), { include: "^a b$", explain: true });
    expect(preview.selected.map((test) => test.name)).toEqual(["a b"]);
    expect(preview.addedByFixture.map((item) => item.test.name)).toEqual(["setup", "cleanup"]);
    expect(preview.addedByFixture.map((item) => item.roles)).toEqual([["setup"], ["cleanup"]]);
    expect(preview.disabled).toEqual([]);
    expect(preview.excludedCounts.include).toBeGreaterThan(0);

    await rm(root, { recursive: true, force: true });
  });
});

describe("test selection", () => {
  const tests = [
    test("plain", { labels: ["dir", "unit", "fast"], fixtures: { required: ["db", "cache"] } }),
    test("setup_db", { labels: ["dir", "setup"], fixtures: { setup: ["db"] } }),
    test("cleanup_db", { labels: ["dir"], fixtures: { cleanup: ["db", "cache"] } }),
    test("disabled_one", { labels: ["dir", "unit"], disabled: true }),
    test("other", { labels: ["dir"] }),
  ];

  it("matches ctest -L AND, -LE AND, and fixture pull-in", () => {
    const both = selectTests(tests, { labels: ["unit", "fast"] });
    expect(names(both)).toEqual(["plain", "setup_db", "cleanup_db"]);

    const either = selectTests(tests, { labels: ["unit|fast"] });
    expect(either.selected.map((item) => item.name)).toEqual(["plain"]);
    expect(either.disabled.map((item) => item.name)).toEqual(["disabled_one"]);
    expect(either.addedByFixture.map((item) => item.test.name).sort()).toEqual(["cleanup_db", "setup_db"]);

    const excludeBoth = selectTests(tests, { excludeLabels: ["unit", "fast"] });
    expect(excludeBoth.selected.map((item) => item.name)).not.toContain("plain");
    expect(excludeBoth.selected.map((item) => item.name)).toContain("setup_db");

    const excludeAny = selectTests(tests, { fixtureExcludeAny: "db|cache", include: "^plain$" });
    expect(excludeAny.selected.map((item) => item.name)).toEqual(["plain"]);
    expect(excludeAny.addedByFixture).toEqual([]);

    const onlyDb = selectTests(tests, { fixtureExcludeAny: "^db$", include: "^plain$" });
    expect(onlyDb.addedByFixture.map((item) => item.test.name)).toEqual(["cleanup_db"]);
  });

  it("does not pull fixtures for a disabled match", () => {
    const disabledNeeds = [
      test("setup", { fixtures: { setup: ["db"] } }),
      test("needs", { disabled: true, fixtures: { required: ["db"] } }),
    ];
    const preview = selectTests(disabledNeeds, { include: "^needs$" });
    expect(preview.disabled.map((item) => item.name)).toEqual(["needs"]);
    expect(preview.addedByFixture).toEqual([]);
  });
});

describe("Test.xml", () => {
  it("decodes escaped output and splits tokens across chunks", () => {
    const xml = Buffer.from(
      `<?xml version="1.0"?>\n<!-- note -->\n<Test Status="failed"><Name>noisy</Name><Results>` +
        `<NamedMeasurement type="text/string" name="Completion Status"><Value>Completed</Value></NamedMeasurement>` +
        `<Measurement><Value>before &lt;/Test&gt; &amp; <![CDATA[kept]]> after\n</Value></Measurement>` +
        `</Results></Test>`,
    );
    const events = tokenizeBuffers([xml.subarray(0, 20), xml.subarray(20, 21), xml.subarray(21)]);
    const text = events.filter((event) => event.type === "text").map((event) => (event.type === "text" ? event.text : ""));
    expect(text.join("")).toContain("before </Test> & kept after");
    expect(events.some((event) => event.type === "start" && event.name === "Test" && event.attrs.Status === "failed")).toBe(true);
  });

  it("indexes a run and truncates one test's output", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ctest-xml-"));
    const tagDir = path.join(root, "Testing", "20261003-0000");
    await mkdir(tagDir, { recursive: true });
    await writeFile(path.join(root, "Testing", "TAG"), "20261003-0000\nExperimental\n");
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>\n<Site BuildName="linux" Generator="ctest" Hostname="box">` +
      `<Testing><StartDateTime>Oct 03 00:00 UTC</StartDateTime><StartTestTime>10</StartTestTime>` +
      `<Test Status="passed"><Name>ok</Name><Path>.</Path><FullName>./ok</FullName>` +
      `<Results><NamedMeasurement type="numeric/double" name="Execution Time"><Value>0.5</Value></NamedMeasurement>` +
      `<NamedMeasurement type="text/string" name="Completion Status"><Value>Completed</Value></NamedMeasurement>` +
      `<Measurement><Value>${"x".repeat(50)}</Value></Measurement></Results></Test>` +
      `<Test Status="notrun"><Name>off</Name><Results>` +
      `<NamedMeasurement type="text/string" name="Completion Status"><Value>Disabled</Value></NamedMeasurement>` +
      `<Measurement><Value>Disabled</Value></Measurement></Results></Test>` +
      `<EndTestTime>12</EndTestTime><ElapsedMinutes>0</ElapsedMinutes></Testing></Site>`;
    const file = path.join(tagDir, "Test.xml");
    await writeFile(file, xml);
    const located = await locateTestXml(root);
    const run = await TestRun.load(located);
    expect(run.summary).toMatchObject({
      total: 2,
      counts: { passed: 1, notrun: 1 },
      startTestTime: 10,
      endTestTime: 12,
      site: { buildName: "linux", hostname: "box" },
    });
    expect(run.tests[0]).toMatchObject({ name: "ok", status: "passed", time: 0.5, completionStatus: "Completed" });
    const details = await readTestResult(file, run.tests[0].offset, 8);
    expect(details.output).toBe("xxxxxxxx");
    expect(details.truncated).toBe(true);
    expect(details.outputBytes).toBe(50);
    expect(details.completionStatus).toBe("Completed");
    await rm(root, { recursive: true, force: true });
  });
});

describe("generated ctest project", () => {
  const root = path.join(os.tmpdir(), `ctest-mcp-gen-${process.pid}`);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("agrees with ctest -N and --show-only", async () => {
    await mkdir(path.join(root, "src", "sub"), { recursive: true });
    await writeFile(
      path.join(root, "src", "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.16)",
        "project(Sample LANGUAGES NONE)",
        "cmake_policy(SET CMP0110 NEW)",
        "enable_testing()",
        "set_property(DIRECTORY PROPERTY LABELS dir)",
        "add_test(NAME plain COMMAND ${CMAKE_COMMAND} -E echo hello)",
        "set_tests_properties(plain PROPERTIES LABELS \"unit;fast\" FIXTURES_REQUIRED \"db;cache\" ENVIRONMENT \"FOO=bar;BAZ=a\\\\;b\")",
        "add_test(NAME setup_db COMMAND ${CMAKE_COMMAND} -E true)",
        "add_test(NAME cleanup_db COMMAND ${CMAKE_COMMAND} -E true)",
        "set_tests_properties(setup_db PROPERTIES FIXTURES_SETUP db LABELS setup)",
        "set_tests_properties(cleanup_db PROPERTIES FIXTURES_CLEANUP \"db;cache\")",
        "add_test(NAME disabled_one COMMAND ${CMAKE_COMMAND} -E true)",
        "set_tests_properties(disabled_one PROPERTIES DISABLED TRUE LABELS unit)",
        "add_subdirectory(sub)",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src", "sub", "CMakeLists.txt"),
      ["add_test(NAME nested.ok COMMAND ${CMAKE_COMMAND} -E echo nested)", 'set_tests_properties(nested.ok PROPERTIES LABELS "unit;nested")', ""].join("\n"),
    );
    const build = path.join(root, "build");
    execFileSync("cmake", ["-S", path.join(root, "src"), "-B", build], { stdio: "ignore" });
    const index = await TestIndex.load(build);
    const tests = index!.testsFor(undefined);
    const plain = tests.find((test) => test.name === "plain")!;
    expect(plain.environment).toEqual(["FOO=bar", "BAZ=a;b"]);
    expect(new Set(plain.labels)).toEqual(new Set(["dir", "unit", "fast"]));
    expect(tests.find((test) => test.name === "nested.ok")?.labels).toEqual(expect.arrayContaining(["dir", "unit", "nested"]));

    const cases: { args: string[]; selector: Parameters<typeof selectTests>[1] }[] = [
      { args: ["-R", "^plain$"], selector: { include: "^plain$" } },
      { args: ["-L", "unit", "-L", "fast"], selector: { labels: ["unit", "fast"] } },
      { args: ["-LE", "unit"], selector: { excludeLabels: ["unit"] } },
      { args: ["-R", "^plain$", "-FA", "db|cache"], selector: { include: "^plain$", fixtureExcludeAny: "db|cache" } },
      { args: ["-R", "^disabled_one$"], selector: { include: "^disabled_one$" } },
    ];
    for (const entry of cases) {
      const listed = ctestNames(build, ["-N", ...entry.args]);
      const preview = selectTests(tests, entry.selector);
      expect(unionNames(preview).sort()).toEqual(listed.sort());
    }

    execFileSync("ctest", ["-T", "Test", "-R", "nested"], { cwd: build, stdio: "ignore" });
    const located = await locateTestXml(build);
    const run = await TestRun.load(located);
    expect(run.tests.map((test) => test.name)).toContain("nested.ok");
    const output = await readFile(located.file, "utf8");
    expect(output).toContain("nested");
  });
});

function test(
  name: string,
  extra: Partial<CTestTest> & { fixtures?: Partial<CTestTest["fixtures"]> } = {},
): CTestTest {
  return {
    name,
    command: ["/bin/true"],
    workingDirectory: "/build",
    sourceDir: "/src",
    testBuildDir: "/build",
    labels: extra.labels ?? [],
    disabled: extra.disabled ?? false,
    depends: extra.depends ?? [],
    fixtures: { setup: [], required: [], cleanup: [], ...extra.fixtures },
    gates: [],
    backtrace: [],
  };
}

function names(selection: ReturnType<typeof selectTests>): string[] {
  return [
    ...selection.selected.map((test) => test.name),
    ...selection.disabled.map((test) => test.name),
    ...selection.addedByFixture.map((item) => item.test.name),
  ];
}

function unionNames(selection: ReturnType<typeof selectTests>): string[] {
  return names(selection);
}

function ctestNames(buildDir: string, args: string[]): string[] {
  const output = execFileSync("ctest", args, { cwd: buildDir, encoding: "utf8" });
  return [...output.matchAll(/^\s+Test\s+#\d+:\s+(\S+)/gm)].map((match) => match[1]);
}
