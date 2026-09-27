// Subset of the CMake File API v1 object model that this server consumes.
// Reference: https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html

export interface ObjectVersion {
  major: number;
  minor: number;
}

export interface ReplyObjectRef {
  kind: string;
  version: ObjectVersion;
  jsonFile: string;
}

export interface ReplyIndex {
  cmake: {
    version: { major: number; minor: number; patch: number; suffix: string; string: string; isDirty: boolean };
    paths: { cmake: string; ctest: string; cpack: string; root: string };
    generator: { multiConfig: boolean; name: string; platform?: string; toolset?: string };
  };
  objects: ReplyObjectRef[];
  reply: Record<string, unknown>;
}

export interface CodemodelDirectory {
  source: string;
  build: string;
  parentIndex?: number;
  childIndexes?: number[];
  projectIndex: number;
  targetIndexes?: number[];
  minimumCMakeVersion?: { string: string };
  hasInstallRule?: boolean;
  jsonFile?: string;
}

export interface CodemodelProject {
  name: string;
  parentIndex?: number;
  childIndexes?: number[];
  directoryIndexes: number[];
  targetIndexes?: number[];
}

export interface CodemodelTargetRef {
  name: string;
  id: string;
  directoryIndex: number;
  projectIndex: number;
  jsonFile: string;
}

export interface CodemodelConfiguration {
  name: string;
  directories: CodemodelDirectory[];
  projects: CodemodelProject[];
  targets: CodemodelTargetRef[];
}

export interface Codemodel {
  kind: "codemodel";
  version: ObjectVersion;
  paths: { source: string; build: string };
  configurations: CodemodelConfiguration[];
}

export interface BacktraceNode {
  file: number;
  line?: number;
  command?: number;
  parent?: number;
}

export interface BacktraceGraph {
  nodes: BacktraceNode[];
  commands: string[];
  files: string[];
}

export interface CommandFragment {
  fragment: string;
  role?: string;
  backtrace?: number;
}

export interface TargetSource {
  path: string;
  compileGroupIndex?: number;
  sourceGroupIndex?: number;
  isGenerated?: boolean;
  fileSetIndex?: number;
  backtrace?: number;
}

export interface CompileGroup {
  sourceIndexes: number[];
  language: string;
  languageStandard?: { standard: string; backtraces?: number[] };
  compileCommandFragments?: CommandFragment[];
  includes?: { path: string; isSystem?: boolean; backtrace?: number }[];
  frameworks?: { path: string; isSystem?: boolean; backtrace?: number }[];
  precompileHeaders?: { header: string; backtrace?: number }[];
  defines?: { define: string; backtrace?: number }[];
  sysroot?: { path: string };
}

export type TargetType =
  | "EXECUTABLE"
  | "STATIC_LIBRARY"
  | "SHARED_LIBRARY"
  | "MODULE_LIBRARY"
  | "OBJECT_LIBRARY"
  | "INTERFACE_LIBRARY"
  | "UTILITY";

export interface Target {
  name: string;
  id: string;
  type: TargetType;
  backtrace?: number;
  folder?: { name: string };
  paths: { source: string; build: string };
  nameOnDisk?: string;
  artifacts?: { path: string }[];
  isGeneratorProvided?: boolean;
  install?: {
    prefix: { path: string };
    destinations: { path: string; backtrace?: number }[];
  };
  launchers?: { command: string; arguments?: string[]; type: string }[];
  link?: {
    language: string;
    commandFragments?: CommandFragment[];
    lto?: boolean;
    sysroot?: { path: string };
  };
  archive?: {
    commandFragments?: CommandFragment[];
    lto?: boolean;
  };
  dependencies?: { id: string; backtrace?: number }[];
  fileSets?: { name: string; type: string; visibility: string; baseDirectories: string[] }[];
  sources?: TargetSource[];
  sourceGroups?: { name: string; sourceIndexes: number[] }[];
  compileGroups?: CompileGroup[];
  backtraceGraph: BacktraceGraph;
}

export interface CacheEntry {
  name: string;
  value: string;
  type: string;
  properties: { name: string; value: string }[];
}

export interface Cache {
  kind: "cache";
  version: ObjectVersion;
  entries: CacheEntry[];
}

export interface CmakeFiles {
  kind: "cmakeFiles";
  version: ObjectVersion;
  paths: { source: string; build: string };
  inputs: { path: string; isGenerated?: boolean; isExternal?: boolean; isCMake?: boolean }[];
  globsDependent?: {
    expression: string;
    recurse?: boolean;
    listDirectories?: boolean;
    followSymlinks?: boolean;
    relative?: string;
    paths: string[];
  }[];
}

export interface Toolchain {
  language: string;
  compiler: {
    path?: string;
    id?: string;
    version?: string;
    target?: string;
    implicit: {
      includeDirectories?: string[];
      linkDirectories?: string[];
      linkFrameworkDirectories?: string[];
      linkLibraries?: string[];
    };
  };
  sourceFileExtensions?: string[];
}

export interface Toolchains {
  kind: "toolchains";
  version: ObjectVersion;
  toolchains: Toolchain[];
}
