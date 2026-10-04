import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { globOrRegex, isWithin } from "../model.js";
import { Workspace, WorkspaceError } from "../workspace.js";
import { CtestError } from "./error.js";
import { testDependencies } from "./graph.js";
import { locateTestXml, readFailedNames, readTestResult } from "./results.js";
import { ctestArgv, selectTests, type FixtureAddition, type Selection, type TestSelector } from "./select.js";
import { showOnly, type ShownTest } from "./showOnly.js";
import { definedAt, type CTestTest, type TestFixtures, type TestIndex } from "./testfile.js";

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

const buildDirArg = z
  .string()
  .optional()
  .describe(
    "Build directory given when the server was started. An absolute path, or a unique suffix such as " +
      "`build-debug`. Omit when the server was started with exactly one build directory.",
  );
const configurationArg = z
  .string()
  .optional()
  .describe(
    "Build configuration passed to ctest -C, such as Debug or Release. Defaults to the build type, " +
      "or the first multi-config configuration when the test file has per-configuration tests.",
  );
const limitArg = z.number().int().positive().max(500).default(100).describe("Maximum rows to return.");
const offsetArg = z.number().int().min(0).default(0).describe("Number of matching rows to skip.");
const testXmlArg = z
  .string()
  .optional()
  .describe("Path to a CTest Test.xml. Omit to read the run named in the build directory's Testing/TAG file.");

const selectorSchema = {
  include: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Include tests whose names match this ctest regex (-R). The search is unanchored and case-sensitive; " +
        "use ^ and $ to anchor, and a|b to match either name. Not a JavaScript regex: \\d, \\b, lookaheads, " +
        "and lazy quantifiers are rejected. { and } are literal.",
    ),
  exclude: z
    .string()
    .min(1)
    .optional()
    .describe("Exclude tests whose names match this ctest regex (-E). Same pattern rules as include."),
  labels: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Label regexes (-L), one per entry. A test is kept only when every regex matches at least one of its labels. " +
        "Put a|b in a single entry to OR labels; two entries require both.",
    ),
  excludeLabels: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Label regexes (-LE). A test is excluded only when every regex matches at least one of its labels.",
    ),
  names: z.array(z.string().min(1)).optional().describe("Exact test names to keep, applied after the regexes."),
  excludeNames: z
    .array(z.string().min(1))
    .optional()
    .describe("Exact test names to drop, applied after the regexes."),
  rerunFailed: z
    .boolean()
    .default(false)
    .describe(
      "Select the tests in Testing/Temporary/LastTestsFailed.log (--rerun-failed). " +
        "Ignores include, exclude, label, and name filters. Fixture setup and cleanup are still added.",
    ),
  fixtureExcludeAny: z
    .string()
    .min(1)
    .optional()
    .describe("Do not add setup or cleanup tests for fixtures whose names match this regex (-FA)."),
  fixtureExcludeSetup: z
    .string()
    .min(1)
    .optional()
    .describe("Do not add setup tests for fixtures whose names match this regex (-FS)."),
  fixtureExcludeCleanup: z
    .string()
    .min(1)
    .optional()
    .describe("Do not add cleanup tests for fixtures whose names match this regex (-FC)."),
};

type SelectorArgs = {
  [K in keyof typeof selectorSchema]?: z.infer<(typeof selectorSchema)[K]>;
};

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function handler<A>(fn: (args: A) => Promise<CallToolResult>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof WorkspaceError || err instanceof CtestError) return errorResult(err.message);
      return errorResult(`Unexpected error: ${(err as Error).stack ?? String(err)}`);
    }
  };
}

export function registerCTestTools(server: McpServer, workspace: Workspace): void {
  async function openIndex(buildDirInput: string | undefined, configuration: string | undefined) {
    const buildDir = await workspace.resolveBuildDir(buildDirInput);
    const index = await workspace.testIndex(buildDir);
    const resolved = resolveConfiguration(workspace, buildDir, configuration, index);
    return { buildDir, index, configuration: resolved, tests: index.testsFor(resolved) };
  }

  server.registerTool(
    "list_tests",
    {
      title: "List tests",
      description:
        "Lists tests defined in the build directory's CTestTestfile.cmake tree. " +
        "Rows are name, labels (including directory labels), disabled, source directory, and fixture roles. " +
        "Name filters are a case-insensitive substring, glob, or /regex/, which is separate from the ctest -R " +
        "regex used by preview_test_run. Results are capped; use offset to page.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        name: z.string().optional().describe("Name filter: case-insensitive substring, glob (`*`, `?`), or /regex/."),
        label: z.string().optional().describe("Exact label. Matches a test label or a label inherited from its directory."),
        fixture: z.string().optional().describe("Fixture name. Matches tests that set up, require, or clean up that fixture."),
        dependency: z.string().optional().describe("Only tests whose DEPENDS list includes this test name."),
        directory: z
          .string()
          .optional()
          .describe("Only tests defined in this source or build directory, or below it. Absolute, or relative to the source root."),
        disabled: z.boolean().optional().describe("When set, only disabled tests (true) or only tests that will run (false)."),
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration, name, label, fixture, dependency, directory, disabled, limit, offset }) => {
      const opened = await openIndex(buildDir, configuration);
      let tests = opened.tests;
      if (name) {
        const regex = globOrRegex(name);
        tests = tests.filter((test) => regex.test(test.name));
      }
      if (label) tests = tests.filter((test) => test.labels.includes(label));
      if (fixture) {
        tests = tests.filter((test) => usesFixture(test.fixtures, fixture));
      }
      if (dependency) tests = tests.filter((test) => test.depends.includes(dependency));
      if (directory) {
        tests = tests.filter((test) =>
          testInDirectory(test, directory, opened.index.sourceDir ?? opened.buildDir, opened.buildDir),
        );
      }
      if (disabled !== undefined) tests = tests.filter((test) => test.disabled === disabled);
      const paged = page(tests, offset, limit);
      return json({
        buildDir: opened.buildDir,
        configuration: opened.configuration,
        count: tests.length,
        offset,
        limit,
        truncated: paged.truncated,
        warnings: opened.index.warnings.length ? opened.index.warnings : undefined,
        tests: paged.items.map((test) => row(test, false)),
      });
    }),
  );

  server.registerTool(
    "get_test",
    {
      title: "Get test",
      description:
        "One test from CTestTestfile.cmake: command, working directory, labels, DEPENDS, fixture roles, " +
        "and the other test properties. Generator expressions are left as written. " +
        "Directory labels are included. The working directory defaults to the test's build directory.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        name: z.string().describe("Exact test name."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration, name }) => {
      const opened = await openIndex(buildDir, configuration);
      const test = opened.index.get(name, opened.configuration);
      return json({
        buildDir: opened.buildDir,
        configuration: opened.configuration,
        ...details(test),
      });
    }),
  );

  server.registerTool(
    "list_labels",
    {
      title: "List test labels",
      description: "Labels used by tests in this configuration, including labels inherited from directories, with a test count for each.",
      inputSchema: { buildDir: buildDirArg, configuration: configurationArg },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration }) => {
      const opened = await openIndex(buildDir, configuration);
      const counts = new Map<string, number>();
      for (const test of opened.tests) {
        for (const label of test.labels) counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      const labels = [...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([label, tests]) => ({ label, tests }));
      return json({
        buildDir: opened.buildDir,
        configuration: opened.configuration,
        count: labels.length,
        labels,
      });
    }),
  );

  server.registerTool(
    "list_fixtures",
    {
      title: "List fixtures",
      description: "Fixtures named by FIXTURES_SETUP, FIXTURES_REQUIRED, and FIXTURES_CLEANUP, with the tests in each role.",
      inputSchema: { buildDir: buildDirArg, configuration: configurationArg },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration }) => {
      const opened = await openIndex(buildDir, configuration);
      const fixtures = new Map<string, { setup: string[]; required: string[]; cleanup: string[] }>();
      const bucket = (name: string) => {
        let fixture = fixtures.get(name);
        if (!fixture) {
          fixture = { setup: [], required: [], cleanup: [] };
          fixtures.set(name, fixture);
        }
        return fixture;
      };
      for (const test of opened.tests) {
        for (const name of test.fixtures.setup) bucket(name).setup.push(test.name);
        for (const name of test.fixtures.required) bucket(name).required.push(test.name);
        for (const name of test.fixtures.cleanup) bucket(name).cleanup.push(test.name);
      }
      const listed = [...fixtures.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, roles]) => ({ name, ...roles }));
      return json({
        buildDir: opened.buildDir,
        configuration: opened.configuration,
        count: listed.length,
        fixtures: listed,
      });
    }),
  );

  server.registerTool(
    "get_test_dependencies",
    {
      title: "Get test dependencies",
      description:
        "DEPENDS edges and fixture edges for one test. Fixture setup tests are prerequisites of tests that " +
        "require the fixture. Fixture cleanup tests are associated with those tests and are not walked through. " +
        "dependencies follows prerequisites; dependents follows the reverse.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        name: z.string().describe("Exact test name."),
        direction: z.enum(["dependencies", "dependents"]).default("dependencies"),
        transitive: z.boolean().default(true),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, configuration, name, direction, transitive }) => {
      const opened = await openIndex(buildDir, configuration);
      opened.index.get(name, opened.configuration);
      const graph = testDependencies(opened.tests, name, direction, transitive);
      return json({
        buildDir: opened.buildDir,
        configuration: opened.configuration,
        test: name,
        direction,
        transitive,
        count: graph.tests.length,
        truncated: graph.truncated,
        tests: graph.tests,
        edges: graph.edges,
      });
    }),
  );

  server.registerTool(
    "preview_test_run",
    {
      title: "Preview a ctest run",
      description:
        "Dry run. Applies ctest's include and exclude rules and returns the tests that would run, the disabled " +
        "tests that match, and the fixture setup/cleanup tests ctest would add. Nothing is executed. " +
        "engine index reads CTestTestfile.cmake. engine ctest runs `ctest --show-only=json-v1` (generator " +
        "expressions are evaluated; ctest updates Testing/Temporary/LastTest.log and does not run tests). " +
        "Pass explain to get a short sample of names dropped by each filter.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        ...selectorSchema,
        engine: z
          .enum(["index", "ctest"])
          .default("index")
          .describe("index uses the parsed test files. ctest runs ctest --show-only=json-v1."),
        includeCommands: z.boolean().default(false).describe("Include each test's command and working directory."),
        explain: z.boolean().default(false).describe("Include up to 20 names for each exclusion reason."),
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => {
      const opened = await openIndex(args.buildDir, args.configuration);
      const selector = await selectorFrom(opened.buildDir, args, args.explain);
      const selection = selectTests(opened.tests, selector);
      if (args.engine === "ctest") {
        const shown = await showOnly(opened.buildDir, selector, opened.configuration);
        return json(
          formatShown(opened, selector, selection, shown, args.includeCommands, args.limit, args.offset, args),
        );
      }
      if (args.engine === "index") {
        return json(formatIndex(opened, selector, selection, args.includeCommands, args.limit, args.offset, args));
      }
      const neverEngine: never = args.engine;
      return neverEngine;
    }),
  );

  server.registerTool(
    "get_test_run_summary",
    {
      title: "Summarize ctest results",
      description:
        "Counts from a CTest Test.xml (passed, failed, notrun), plus the run's start time and duration. " +
        "Reads Testing/TAG unless testXml is given. Does not return per-test output.",
      inputSchema: { buildDir: buildDirArg, testXml: testXmlArg },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, testXml }) => {
      const dir = await workspace.resolveBuildDir(buildDir);
      const located = await locateTestXml(dir, testXml);
      const run = await workspace.testRun(located);
      return json({
        buildDir: dir,
        file: run.file,
        tag: run.tag,
        track: run.track,
        ...run.summary,
      });
    }),
  );

  server.registerTool(
    "list_test_results",
    {
      title: "List ctest results",
      description:
        "Results from Test.xml: name, status, time, exit code, and completion status. No test output. " +
        "Optional include and exclude regexes use the same rules as preview_test_run and keep the fixture " +
        "tests ctest would have added. Filter status to passed, failed, or notrun.",
      inputSchema: {
        buildDir: buildDirArg,
        configuration: configurationArg,
        testXml: testXmlArg,
        ...selectorSchema,
        status: z.enum(["passed", "failed", "notrun"]).optional().describe("Only results with this status."),
        limit: limitArg,
        offset: offsetArg,
      },
      annotations: READ_ONLY,
    },
    handler(async (args) => {
      const dir = await workspace.resolveBuildDir(args.buildDir);
      const located = await locateTestXml(dir, args.testXml);
      const run = await workspace.testRun(located);
      let entries = run.tests;
      if (selectorActive(args)) {
        const opened = await openIndex(dir, args.configuration);
        const selector = await selectorFrom(dir, args);
        const selection = selectTests(opened.tests, selector);
        const names = new Set<string>([
          ...selection.selected.map((test) => test.name),
          ...selection.disabled.map((test) => test.name),
          ...selection.addedByFixture.map((item) => item.test.name),
        ]);
        entries = entries.filter((entry) => names.has(entry.name));
      }
      if (args.status) entries = entries.filter((entry) => entry.status === args.status);
      const paged = page(entries, args.offset, args.limit);
      return json({
        buildDir: dir,
        file: run.file,
        count: entries.length,
        offset: args.offset,
        limit: args.limit,
        truncated: paged.truncated,
        tests: paged.items.map((entry) => ({
          name: entry.name,
          status: entry.status,
          time: entry.time,
          exitCode: entry.exitCode,
          exitValue: entry.exitValue,
          completionStatus: entry.completionStatus,
          labels: entry.labels.length ? entry.labels : undefined,
        })),
      });
    }),
  );

  server.registerTool(
    "get_test_result",
    {
      title: "Get one ctest result",
      description:
        "One test's status, measurements, and stdout from Test.xml. Stdout is truncated to maxOutputBytes. " +
        "Attached files are described, not inlined.",
      inputSchema: {
        buildDir: buildDirArg,
        testXml: testXmlArg,
        name: z.string().describe("Exact test name."),
        maxOutputBytes: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .default(4000)
          .describe("Maximum stdout bytes to return."),
      },
      annotations: READ_ONLY,
    },
    handler(async ({ buildDir, testXml, name, maxOutputBytes }) => {
      const dir = await workspace.resolveBuildDir(buildDir);
      const located = await locateTestXml(dir, testXml);
      const run = await workspace.testRun(located);
      const matches = run.named(name);
      const entry = matches.at(-1);
      if (!entry) throw new CtestError(`No result named '${name}' in ${run.file}.`);
      const detailsResult = await readTestResult(run.file, entry.offset, maxOutputBytes);
      return json({
        buildDir: dir,
        file: run.file,
        duplicates: matches.length > 1 ? matches.length : undefined,
        ...detailsResult,
      });
    }),
  );
}

function resolveConfiguration(
  workspace: Workspace,
  buildDir: string,
  requested: string | undefined,
  index: TestIndex,
): string | undefined {
  if (requested) return requested;
  const info = workspace.getBuildDirInfo(buildDir);
  if (!index.hasConfigGates) return info?.buildType;
  const fallback = info?.buildType || info?.configurationTypes?.[0];
  if (fallback) return fallback;
  throw new CtestError(
    `Tests in ${buildDir} depend on the build configuration. Pass \`configuration\` (for example Debug or Release).`,
  );
}

async function selectorFrom(buildDir: string, args: SelectorArgs, explain = false): Promise<TestSelector> {
  const failedNames = args.rerunFailed ? await readFailedNames(buildDir) : undefined;
  return {
    include: args.include,
    exclude: args.exclude,
    labels: args.labels,
    excludeLabels: args.excludeLabels,
    names: args.names,
    excludeNames: args.excludeNames,
    failedNames,
    fixtureExcludeAny: args.fixtureExcludeAny,
    fixtureExcludeSetup: args.fixtureExcludeSetup,
    fixtureExcludeCleanup: args.fixtureExcludeCleanup,
    explain,
  };
}

function selectorActive(args: SelectorArgs): boolean {
  return Boolean(
    args.include ||
      args.exclude ||
      args.labels?.length ||
      args.excludeLabels?.length ||
      args.names?.length ||
      args.excludeNames?.length ||
      args.rerunFailed ||
      args.fixtureExcludeAny ||
      args.fixtureExcludeSetup ||
      args.fixtureExcludeCleanup,
  );
}

interface Opened {
  buildDir: string;
  index: TestIndex;
  configuration: string | undefined;
  tests: CTestTest[];
}

function formatIndex(
  opened: Opened,
  selector: TestSelector,
  selection: Selection,
  includeCommands: boolean,
  limit: number,
  offset: number,
  args: SelectorArgs,
) {
  const selected = page(selection.selected, offset, limit);
  const added = page(selection.addedByFixture, 0, limit);
  const disabled = page(selection.disabled, 0, limit);
  return {
    buildDir: opened.buildDir,
    configuration: opened.configuration,
    engine: "index" as const,
    command: ctestArgv(opened.buildDir, selector, opened.configuration),
    note: notes(args, "index"),
    warnings: opened.index.warnings.length ? opened.index.warnings : undefined,
    counts: countsOf(opened.tests.length, selection.selected.length, selection.addedByFixture.length, selection.disabled.length, selection),
    unknownNames: selection.unknownNames.length ? selection.unknownNames : undefined,
    selected: selected.items.map((test) => row(test, includeCommands)),
    addedByFixture: added.items.map((item) => addedRow(item, includeCommands)),
    disabled: disabled.items.map((test) => row(test, includeCommands)),
    excluded: selection.excludedSamples,
    truncated: truncatedOf(selected.truncated, added.truncated, disabled.truncated),
  };
}

function formatShown(
  opened: Opened,
  selector: TestSelector,
  selection: Selection,
  shown: ShownTest[],
  includeCommands: boolean,
  limit: number,
  offset: number,
  args: SelectorArgs,
) {
  const selectedNames = new Set(selection.selected.map((test) => test.name));
  const disabledNames = new Set(selection.disabled.map((test) => test.name));
  const addedBy = new Map(selection.addedByFixture.map((item) => [item.test.name, item]));
  const selected: ReturnType<typeof shownRow>[] = [];
  const disabled: ReturnType<typeof shownRow>[] = [];
  const added: ReturnType<typeof shownRow>[] = [];
  for (const test of shown) {
    const known = addedBy.get(test.name);
    if (known && !selectedNames.has(test.name)) {
      added.push(shownRow(test, includeCommands, { roles: known.roles, fixtures: known.fixtures }));
    } else if (test.disabled || disabledNames.has(test.name)) {
      disabled.push(shownRow(test, includeCommands));
    } else if (selectedNames.has(test.name)) {
      selected.push(shownRow(test, includeCommands));
    } else {
      added.push(
        shownRow(test, includeCommands, {
          roles: rolesFromFixtures(test.fixtures),
          fixtures: [...test.fixtures.setup, ...test.fixtures.cleanup],
        }),
      );
    }
  }
  const selectedPage = page(selected, offset, limit);
  const addedPage = page(added, 0, limit);
  const disabledPage = page(disabled, 0, limit);
  return {
    buildDir: opened.buildDir,
    configuration: opened.configuration,
    engine: "ctest" as const,
    command: ctestArgv(opened.buildDir, selector, opened.configuration),
    note: notes(args, "ctest"),
    warnings: opened.index.warnings.length ? opened.index.warnings : undefined,
    counts: countsOf(opened.tests.length, selected.length, added.length, disabled.length, selection),
    unknownNames: selection.unknownNames.length ? selection.unknownNames : undefined,
    selected: selectedPage.items,
    addedByFixture: addedPage.items,
    disabled: disabledPage.items,
    excluded: selection.excludedSamples,
    truncated: truncatedOf(selectedPage.truncated, addedPage.truncated, disabledPage.truncated),
  };
}

function countsOf(total: number, selected: number, addedByFixture: number, disabled: number, selection: Selection) {
  return {
    total,
    selected,
    addedByFixture,
    disabled,
    excluded: Object.keys(selection.excludedCounts).length ? selection.excludedCounts : undefined,
  };
}

function notes(args: SelectorArgs, engine: "index" | "ctest"): string | undefined {
  const parts: string[] = [];
  if (args.rerunFailed && (args.include || args.exclude || args.labels?.length || args.excludeLabels?.length || args.names?.length || args.excludeNames?.length)) {
    parts.push("ctest --rerun-failed ignores include, exclude, label, and name filters. Fixture setup and cleanup are still added.");
  }
  if (engine === "ctest") {
    parts.push("ctest --show-only does not execute tests. It updates Testing/Temporary/LastTest.log. Exclusion counts are computed from the test files.");
  } else if (args.names?.length || args.excludeNames?.length) {
    parts.push("Exact name lists are applied by the index. engine ctest passes them via --tests-from-file, which needs CMake 3.29 or newer.");
  }
  return parts.length ? parts.join(" ") : undefined;
}

function row(test: CTestTest, includeCommands: boolean) {
  return {
    name: test.name,
    labels: test.labels.length ? test.labels : undefined,
    disabled: test.disabled || undefined,
    directory: test.sourceDir || undefined,
    fixtures: fixtureView(test.fixtures),
    command: includeCommands ? test.command : undefined,
    workingDirectory: includeCommands ? test.workingDirectory : undefined,
  };
}

function addedRow(item: FixtureAddition, includeCommands: boolean) {
  return {
    name: item.test.name,
    roles: item.roles,
    fixtures: item.fixtures,
    disabled: item.test.disabled || undefined,
    labels: item.test.labels.length ? item.test.labels : undefined,
    command: includeCommands ? item.test.command : undefined,
    workingDirectory: includeCommands ? item.test.workingDirectory : undefined,
  };
}

function shownRow(
  test: ShownTest,
  includeCommands: boolean,
  extra?: { roles: ("setup" | "cleanup")[]; fixtures: string[] },
) {
  return {
    name: test.name,
    roles: extra?.roles,
    fixtures: extra ? extra.fixtures : fixtureView(test.fixtures),
    disabled: test.disabled || undefined,
    labels: test.labels.length ? test.labels : undefined,
    command: includeCommands ? test.command : undefined,
    workingDirectory: includeCommands ? test.workingDirectory : undefined,
  };
}

function rolesFromFixtures(fixtures: TestFixtures): ("setup" | "cleanup")[] {
  const roles: ("setup" | "cleanup")[] = [];
  if (fixtures.setup.length) roles.push("setup");
  if (fixtures.cleanup.length) roles.push("cleanup");
  return roles;
}

function details(test: CTestTest) {
  return {
    name: test.name,
    definedAt: definedAt(test),
    command: test.command,
    workingDirectory: test.workingDirectory,
    sourceDir: test.sourceDir || undefined,
    testBuildDir: test.testBuildDir,
    labels: test.labels.length ? test.labels : undefined,
    disabled: test.disabled || undefined,
    depends: test.depends.length ? test.depends : undefined,
    fixtures: fixtureView(test.fixtures),
    environment: test.environment,
    timeout: test.timeout,
    cost: test.cost,
    processors: test.processors,
    skipReturnCode: test.skipReturnCode,
    passRegularExpression: test.passRegularExpression,
    failRegularExpression: test.failRegularExpression,
    skipRegularExpression: test.skipRegularExpression,
    willFail: test.willFail,
    runSerial: test.runSerial,
    resourceLock: test.resourceLock,
    requiredFiles: test.requiredFiles,
    attachedFiles: test.attachedFiles,
    attachedFilesOnFail: test.attachedFilesOnFail,
    configurations: test.configurations,
    backtrace: test.backtrace.length ? test.backtrace : undefined,
    properties: test.properties,
  };
}

function fixtureView(fixtures: TestFixtures): { setup?: string[]; required?: string[]; cleanup?: string[] } | undefined {
  const view = {
    setup: fixtures.setup.length ? fixtures.setup : undefined,
    required: fixtures.required.length ? fixtures.required : undefined,
    cleanup: fixtures.cleanup.length ? fixtures.cleanup : undefined,
  };
  if (!view.setup && !view.required && !view.cleanup) return undefined;
  return view;
}

function usesFixture(fixtures: TestFixtures, name: string): boolean {
  return fixtures.setup.includes(name) || fixtures.required.includes(name) || fixtures.cleanup.includes(name);
}

function testInDirectory(test: CTestTest, filter: string, sourceRoot: string, buildRoot: string): boolean {
  const source = path.isAbsolute(filter) ? path.normalize(filter) : path.resolve(sourceRoot, filter);
  const build = path.isAbsolute(filter) ? path.normalize(filter) : path.resolve(buildRoot, filter);
  return (
    isWithin(test.sourceDir, source) ||
    isWithin(test.testBuildDir, source) ||
    isWithin(test.testBuildDir, build) ||
    isWithin(test.sourceDir, build)
  );
}

function page<T>(items: T[], offset: number, limit: number): { items: T[]; truncated?: true } {
  const slice = items.slice(offset, offset + limit);
  return { items: slice, truncated: offset + slice.length < items.length ? true : undefined };
}

function truncatedOf(selected?: true, addedByFixture?: true, disabled?: true) {
  if (!selected && !addedByFixture && !disabled) return undefined;
  return { selected, addedByFixture, disabled };
}
