import type { CTestTest } from "./testfile.js";
import { ctestRegex } from "./regex.js";

export const EXCLUDE_REASONS = ["include", "exclude", "label", "labelExclude", "name", "excludeName", "rerunFailed"] as const;
export type ExcludeReason = (typeof EXCLUDE_REASONS)[number];

export interface TestSelector {
  include?: string;
  exclude?: string;
  /** Each entry is one `-L` regex. A test matches only when every regex matches one of its labels. */
  labels?: string[];
  /** Each entry is one `-LE` regex. A test is excluded only when every regex matches one of its labels. */
  excludeLabels?: string[];
  names?: string[];
  excludeNames?: string[];
  /**
   * Names from `LastTestsFailed.log`. When set, include/exclude/label/name filters are ignored,
   * matching `ctest --rerun-failed`.
   */
  failedNames?: string[];
  fixtureExcludeAny?: string;
  fixtureExcludeSetup?: string;
  fixtureExcludeCleanup?: string;
  explain?: boolean;
}

export interface FixtureAddition {
  test: CTestTest;
  roles: ("setup" | "cleanup")[];
  fixtures: string[];
}

export interface Selection {
  selected: CTestTest[];
  disabled: CTestTest[];
  addedByFixture: FixtureAddition[];
  excludedCounts: Partial<Record<ExcludeReason, number>>;
  excludedSamples?: Partial<Record<ExcludeReason, string[]>>;
  unknownNames: string[];
}

const EXPLAIN_SAMPLE = 20;

/** Tests that would run, tests ctest would still list as disabled, and fixture setup/cleanup pulled in afterwards. */
export function selectTests(tests: CTestTest[], selector: TestSelector): Selection {
  const include = selector.include ? ctestRegex(selector.include) : undefined;
  const exclude = selector.exclude ? ctestRegex(selector.exclude) : undefined;
  const labelRes = (selector.labels ?? []).map((pattern) => ctestRegex(pattern));
  const excludeLabelRes = (selector.excludeLabels ?? []).map((pattern) => ctestRegex(pattern));
  const names = selector.names ? new Set(selector.names) : undefined;
  const excludeNames = selector.excludeNames ? new Set(selector.excludeNames) : undefined;
  const failed = selector.failedNames ? new Set(selector.failedNames) : undefined;
  const blockAny = selector.fixtureExcludeAny ? ctestRegex(selector.fixtureExcludeAny) : undefined;
  const blockSetup = selector.fixtureExcludeSetup ? ctestRegex(selector.fixtureExcludeSetup) : undefined;
  const blockCleanup = selector.fixtureExcludeCleanup ? ctestRegex(selector.fixtureExcludeCleanup) : undefined;

  const known = new Set(tests.map((test) => test.name));
  const unknownNames: string[] = [];
  for (const name of [...(selector.names ?? []), ...(selector.failedNames ?? [])]) {
    if (!known.has(name) && !unknownNames.includes(name)) unknownNames.push(name);
  }

  const selected: CTestTest[] = [];
  const disabled: CTestTest[] = [];
  const failures: { name: string; reason: ExcludeReason }[] = [];
  for (const test of tests) {
    const reason = failureReason(test, { include, exclude, labelRes, excludeLabelRes, names, excludeNames, failed });
    if (reason) {
      failures.push({ name: test.name, reason });
      continue;
    }
    if (test.disabled) disabled.push(test);
    else selected.push(test);
  }

  const setupBy = fixturesBy(tests, "setup");
  const cleanupBy = fixturesBy(tests, "cleanup");
  const accounted = new Set([...selected, ...disabled].map((test) => test.name));
  const added = new Map<string, { test: CTestTest; roles: Set<"setup" | "cleanup">; fixtures: Set<string> }>();
  const queue = [...selected];
  const expanded = new Set<string>();

  const pull = (test: CTestTest, role: "setup" | "cleanup", fixture: string) => {
    if (accounted.has(test.name)) return;
    let entry = added.get(test.name);
    if (!entry) {
      entry = { test, roles: new Set(), fixtures: new Set() };
      added.set(test.name, entry);
      if (!test.disabled) queue.push(test);
    }
    entry.roles.add(role);
    entry.fixtures.add(fixture);
  };

  while (queue.length) {
    const test = queue.shift();
    if (!test || expanded.has(test.name)) continue;
    expanded.add(test.name);
    for (const fixture of test.fixtures.required) {
      const skipAny = blockAny?.test(fixture) ?? false;
      if (!skipAny && !blockSetup?.test(fixture)) {
        for (const setup of setupBy.get(fixture) ?? []) pull(setup, "setup", fixture);
      }
      if (!skipAny && !blockCleanup?.test(fixture)) {
        for (const cleanup of cleanupBy.get(fixture) ?? []) pull(cleanup, "cleanup", fixture);
      }
    }
  }

  const order = new Map(tests.map((test, index) => [test.name, index]));
  const addedByFixture: FixtureAddition[] = [...added.values()]
    .sort((a, b) => (order.get(a.test.name) ?? 0) - (order.get(b.test.name) ?? 0))
    .map((entry) => ({
      test: entry.test,
      roles: [...entry.roles],
      fixtures: [...entry.fixtures],
    }));

  const addedNames = new Set(added.keys());
  const excludedCounts: Partial<Record<ExcludeReason, number>> = {};
  const excludedSamples: Partial<Record<ExcludeReason, string[]>> = {};
  for (const failure of failures) {
    if (addedNames.has(failure.name)) continue;
    excludedCounts[failure.reason] = (excludedCounts[failure.reason] ?? 0) + 1;
    if (!selector.explain) continue;
    const sample = excludedSamples[failure.reason] ?? [];
    if (sample.length < EXPLAIN_SAMPLE) {
      sample.push(failure.name);
      excludedSamples[failure.reason] = sample;
    }
  }

  return {
    selected,
    disabled,
    addedByFixture,
    excludedCounts,
    excludedSamples: selector.explain ? excludedSamples : undefined,
    unknownNames,
  };
}

export function ctestArgv(buildDir: string, selector: TestSelector, configuration: string | undefined): string[] {
  const args = ["ctest", "--show-only=json-v1", "--test-dir", buildDir];
  if (configuration) args.push("-C", configuration);
  if (selector.failedNames) {
    args.push("--rerun-failed");
    return args;
  }
  if (selector.include) args.push("-R", selector.include);
  if (selector.exclude) args.push("-E", selector.exclude);
  for (const label of selector.labels ?? []) args.push("-L", label);
  for (const label of selector.excludeLabels ?? []) args.push("-LE", label);
  if (selector.fixtureExcludeAny) args.push("-FA", selector.fixtureExcludeAny);
  if (selector.fixtureExcludeSetup) args.push("-FS", selector.fixtureExcludeSetup);
  if (selector.fixtureExcludeCleanup) args.push("-FC", selector.fixtureExcludeCleanup);
  return args;
}

function failureReason(
  test: CTestTest,
  filter: {
    include?: RegExp;
    exclude?: RegExp;
    labelRes: RegExp[];
    excludeLabelRes: RegExp[];
    names?: Set<string>;
    excludeNames?: Set<string>;
    failed?: Set<string>;
  },
): ExcludeReason | undefined {
  if (filter.failed) return filter.failed.has(test.name) ? undefined : "rerunFailed";
  if (filter.include && !filter.include.test(test.name)) return "include";
  if (filter.exclude && filter.exclude.test(test.name)) return "exclude";
  if (filter.labelRes.length > 0 && !filter.labelRes.every((regex) => test.labels.some((label) => regex.test(label)))) {
    return "label";
  }
  if (
    filter.excludeLabelRes.length > 0 &&
    filter.excludeLabelRes.every((regex) => test.labels.some((label) => regex.test(label)))
  ) {
    return "labelExclude";
  }
  if (filter.names && !filter.names.has(test.name)) return "name";
  if (filter.excludeNames?.has(test.name)) return "excludeName";
  return undefined;
}

function fixturesBy(tests: CTestTest[], role: "setup" | "cleanup"): Map<string, CTestTest[]> {
  const map = new Map<string, CTestTest[]>();
  for (const test of tests) {
    const names = role === "setup" ? test.fixtures.setup : test.fixtures.cleanup;
    for (const fixture of names) {
      const list = map.get(fixture) ?? [];
      list.push(test);
      map.set(fixture, list);
    }
  }
  return map;
}
