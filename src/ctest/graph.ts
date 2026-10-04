import type { CTestTest } from "./testfile.js";

export type DependencyKind = "depends" | "fixture-setup" | "fixture-cleanup";

export interface DependencyEdge {
  from: string;
  to: string;
  kind: DependencyKind;
  fixture?: string;
  missing?: true;
}

const EDGE_CAP = 500;

/**
 * `depends` and `fixture-setup` edges point at a prerequisite.
 * `fixture-cleanup` edges point at the cleanup test and are listed, not walked through.
 */
export function testDependencies(
  tests: CTestTest[],
  root: string,
  direction: "dependencies" | "dependents",
  transitive: boolean,
): { tests: { name: string; missing?: true }[]; edges: DependencyEdge[]; truncated?: true } {
  const edges = allEdges(tests);
  const visited = new Set<string>([root]);
  const queue = [root];
  const used: DependencyEdge[] = [];
  const seen = new Set<string>();
  let truncated: true | undefined;

  const touches = (edge: DependencyEdge, node: string) =>
    direction === "dependencies" ? edge.from === node : edge.to === node;
  const nextOf = (edge: DependencyEdge) => (direction === "dependencies" ? edge.to : edge.from);

  while (queue.length) {
    const node = queue.shift();
    if (node === undefined) break;
    for (const edge of edges) {
      if (!touches(edge, node)) continue;
      const key = `${edge.kind}\0${edge.from}\0${edge.to}\0${edge.fixture ?? ""}`;
      if (seen.has(key)) continue;
      const walk = edge.kind === "depends" || edge.kind === "fixture-setup";
      if (!walk && node !== root && !transitive) continue;
      if (used.length >= EDGE_CAP) {
        truncated = true;
        continue;
      }
      seen.add(key);
      used.push(edge);
      if (!walk || edge.missing) continue;
      const next = nextOf(edge);
      if (visited.has(next)) continue;
      visited.add(next);
      if (transitive) queue.push(next);
    }
    if (!transitive) break;
  }

  const listed = new Map<string, { name: string; missing?: true }>();
  for (const edge of used) {
    const other = direction === "dependencies" ? edge.to : edge.from;
    if (other === root) continue;
    const prior = listed.get(other);
    if (!prior) listed.set(other, { name: other, missing: edge.missing });
    else if (edge.missing) prior.missing = true;
  }
  return { tests: [...listed.values()], edges: used, truncated };
}

function allEdges(tests: CTestTest[]): DependencyEdge[] {
  const known = new Set(tests.map((test) => test.name));
  const setup = new Map<string, string[]>();
  const cleanup = new Map<string, string[]>();
  for (const test of tests) {
    for (const fixture of test.fixtures.setup) push(setup, fixture, test.name);
    for (const fixture of test.fixtures.cleanup) push(cleanup, fixture, test.name);
  }
  const edges: DependencyEdge[] = [];
  for (const test of tests) {
    for (const dependency of test.depends) {
      edges.push({
        from: test.name,
        to: dependency,
        kind: "depends",
        missing: known.has(dependency) ? undefined : true,
      });
    }
    for (const fixture of test.fixtures.required) {
      for (const name of setup.get(fixture) ?? []) {
        edges.push({ from: test.name, to: name, kind: "fixture-setup", fixture });
      }
      for (const name of cleanup.get(fixture) ?? []) {
        edges.push({ from: test.name, to: name, kind: "fixture-cleanup", fixture });
      }
    }
  }
  return edges;
}

function push(map: Map<string, string[]>, fixture: string, name: string): void {
  const list = map.get(fixture) ?? [];
  list.push(name);
  map.set(fixture, list);
}
