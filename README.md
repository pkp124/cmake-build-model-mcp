# cmake-build-model-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants query the **build model of CMake
projects** — targets, sources, compile flags, include directories, defines, language standards, dependencies,
artifacts, install rules, cache variables and toolchains — using the
[CMake File API](https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html).

It is workspace-aware: it discovers **multiple CMake projects** under one or more roots and **multiple build
directories per project** (e.g. `build-debug`, `build-release`, preset build trees, multi-config generators),
and can answer questions like *"how is this file compiled?"* across all of them at once.

## How it works

1. **Discovery.** Each workspace root is scanned for top-level `CMakeLists.txt` files (source projects) and for
   `CMakeCache.txt` files (build directories). A build directory is linked to its project through
   `CMAKE_HOME_DIRECTORY`, and the `binaryDir` of configure presets in `CMakePresets.json` /
   `CMakeUserPresets.json` is resolved, so build trees outside the roots are found too.
2. **Query.** For every build directory it touches, the server writes a stateful File API client query
   (`.cmake/api/v1/query/client-cmake-build-model-mcp/query.json`) requesting `codemodel` v2, `cache` v2,
   `cmakeFiles` v1 and `toolchains` v1.
3. **Reply.** CMake writes the reply the next time it configures. If there is no reply yet, the server re-runs
   CMake on the existing build directory by default (like IDE integrations do). Replies are loaded lazily and
   cached until the reply index changes. Replies generated for other clients (e.g. VS Code CMake Tools) are
   reused when they contain the needed objects.
4. **Staleness.** Using the `cmakeFiles` object, the server reports when a `CMakeLists.txt` or included
   `.cmake` file has been modified since the last configure.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_projects` | Source projects and build directories in the workspace, with generator, build type and File API status (available, stale, modified inputs). |
| `register_build_dir` | Add an existing build directory that lives outside the workspace roots. |
| `list_presets` | Configure and build presets of a source directory, with resolved binary directories. |
| `configure` | Run CMake configure: with a preset, from a source directory into a (new) build directory, or re-run on an existing build directory. |
| `build` | `cmake --build` for a build directory and optional targets/configuration. |
| `get_project_summary` | CMake version, generator, configurations, `project()` hierarchy, targets grouped by type. |
| `list_targets` | Targets filtered by type, name (substring / glob / `/regex/`), project or directory. |
| `get_target` | Everything about one target: definition site, artifacts, dependencies, compile groups (flags, defines, includes, standard, PCH), link/archive fragments, install destinations, sources, optional backtraces. |
| `get_target_dependencies` | Direct or transitive dependencies or dependents of a target. |
| `find_file_targets` | Which targets compile a file (in every build directory and configuration), with effective flags and an approximate compiler command. Headers fall back to targets whose include directories contain them. |
| `get_cache_variables` | Cache entries with type, value, help string; filterable. |
| `get_toolchains` | Compilers per language with implicit include/link directories. |
| `get_cmake_inputs` | Files CMake read during configure, glob dependencies, and inputs modified since then. |

Most tools accept a `buildDir` argument: an absolute path, a path relative to a workspace root, or a source
directory that has exactly one build directory. It can be omitted when the workspace has a single build
directory. Multi-config generators (Visual Studio, Xcode, Ninja Multi-Config) are supported through the
`configuration` argument.

Example `find_file_targets` result:

```json
{
  "file": "/src/app/tools/main.cpp",
  "matches": [
    {
      "buildDir": "/src/app/build",
      "target": "app_cli",
      "targetType": "EXECUTABLE",
      "matchedBy": "source",
      "compileGroup": {
        "language": "CXX",
        "languageStandard": "20",
        "compileFlags": ["-std=gnu++20", "-Wall"],
        "defines": ["CORE_VERSION=3"],
        "includes": [{ "path": "/src/app/include" }]
      },
      "compileCommand": ["/usr/bin/c++", "-DCORE_VERSION=3", "-I/src/app/include", "-std=gnu++20", "-Wall", "-c", "/src/app/tools/main.cpp"]
    }
  ]
}
```

## Requirements

- Node.js 18+
- CMake 3.14+ (3.20+ for `toolchains`; newer versions add fields such as `languageStandard`).
  The server uses the `cmake` recorded in each build directory's cache for re-configures.

## Installation

```bash
git clone https://github.com/pkp124/cmake-build-model-mcp.git
cd cmake-build-model-mcp
npm install        # also builds dist/
```

## Configuration

The server speaks MCP over stdio.

```text
cmake-build-model-mcp [options] [root...]

  --root <dir>              Workspace root to scan (repeatable; also CMAKE_MCP_ROOTS).
                            Without roots, the client's MCP roots are used, else the current directory.
  --build-dir <dir>         Additional build directory outside the roots (repeatable).
  --cmake <path>            cmake executable for new build directories (default: cmake).
  --max-depth <n>           Maximum scan depth below each root (default: 6).
  --auto-configure <mode>   never | missing (default) | stale
  --configure-timeout <s>   Configure timeout (default: 600).
  --build-timeout <s>       Default build timeout (default: 3600).
```

`--auto-configure` controls when the server runs CMake by itself: `never` only through the `configure` tool,
`missing` when a build directory has no File API reply yet, `stale` also when CMake inputs changed since the
last configure.

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "cmake-build-model": {
      "command": "node",
      "args": ["/path/to/cmake-build-model-mcp/dist/index.js", "--root", "${workspaceFolder}"]
    }
  }
}
```

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "cmake-build-model": {
      "command": "node",
      "args": ["/path/to/cmake-build-model-mcp/dist/index.js", "/path/to/workspace"]
    }
  }
}
```

```bash
claude mcp add cmake-build-model -- node /path/to/cmake-build-model-mcp/dist/index.js "$PWD"
```

### VS Code (`.vscode/mcp.json`)

VS Code provides MCP roots, so no `--root` is needed:

```json
{
  "servers": {
    "cmake-build-model": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/cmake-build-model-mcp/dist/index.js"]
    }
  }
}
```

## Notes and limitations

- Top-level projects are detected as `CMakeLists.txt` files with no `CMakeLists.txt` in an ancestor
  directory below the root; nested independent projects are picked up once they have a build directory, or
  via `configure` with `sourceDir`.
- `INTERFACE` libraries only appear in the codemodel when they have sources (a CMake File API rule).
- `compileCommand` is reconstructed from the File API and omits output flags; use `compile_commands.json`
  (`CMAKE_EXPORT_COMPILE_COMMANDS`) when the exact command line matters.
- Directories starting with `.`, `node_modules`, `CMakeFiles` and `_deps` are not scanned.

## Development

```bash
npm run build     # compile TypeScript to dist/
npm test          # build + unit and end-to-end tests (needs cmake and a C/C++ compiler; ninja optional)
```

The end-to-end tests copy `test/fixtures/workspace` (two independent projects, one with presets) into a
temporary directory, drive the compiled server over stdio with the MCP SDK client and configure several build
directories, including a Ninja Multi-Config one when `ninja` is available.

## License

MIT
