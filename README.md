# cmake-build-model-mcp

An [MCP](https://modelcontextprotocol.io) server that lets AI assistants query the **build model of CMake
projects** — targets, sources, compile flags, include directories, defines, language standards, dependencies,
artifacts, install rules, cache variables and toolchains — using the
[CMake File API](https://cmake.org/cmake/help/latest/manual/cmake-file-api.7.html), plus the exact compiler
invocations from `compile_commands.json`. It also queries the **ctest model** written into `CTestTestfile.cmake`
(names, labels, fixtures, dependencies) and the results in `Test.xml`, so a large suite can be filtered without
pasting those files into the conversation.

Point it at one or more **build directories** that already contain a File API reply (for example `build-debug`
and `build-release`, or a multi-config build). It can answer questions like *"how is this file compiled?"*
across every build directory it was given.

The server is **read-only**: it never runs CMake, never executes tests, and never writes into build directories,
except that `preview_test_run` with `engine: "ctest"` runs `ctest --show-only` (a dry run). That updates
`Testing/Temporary/LastTest.log` and does not run test executables. Everything else only reads what a previous
configure or `ctest -T Test` left behind.

## Prerequisites for build directories

Each build directory must already contain a File API reply with at least the `codemodel` object. Create the
query files before configuring (or re-configure after creating them):

```bash
mkdir -p build/.cmake/api/v1/query
touch build/.cmake/api/v1/query/{codemodel-v2,cache-v2,cmakeFiles-v1,toolchains-v1}
cmake -S . -B build -DCMAKE_EXPORT_COMPILE_COMMANDS=ON
```

- `codemodel-v2` is required; `cache-v2`, `cmakeFiles-v1` and `toolchains-v1` enable the cache, inputs /
  staleness and toolchain tools.
- Replies requested by other clients (e.g. VS Code CMake Tools or CLion) are used as well, so build
  directories managed by an IDE usually work as-is.
- `CMAKE_EXPORT_COMPILE_COMMANDS=ON` (Makefile and Ninja generators) writes `compile_commands.json`, which
  `find_file_targets` and `get_compile_commands` read. Without it, everything else still works.

## How it works

1. **Build directories.** Each directory passed on the command line is recorded. `CMakeCache.txt` in that
   directory supplies the source directory, generator and build type.
2. **Reply.** The newest `.cmake/api/v1/reply/index-*.json` is read; objects are loaded lazily and cached until
   the reply index changes, so re-configuring outside the server is picked up automatically.
3. **Compile commands.** `<buildDir>/compile_commands.json` is loaded (and re-loaded when it changes) and
   indexed by source file. Entries are attributed to targets and configurations through their object file
   path (`CMakeFiles/<target>.dir/[<config>/]...`).
4. **Staleness.** Using the `cmakeFiles` object, the server reports when a `CMakeLists.txt` or included
   `.cmake` file has been modified since the last configure.

## Tools

| Tool | Purpose |
| --- | --- |
| `list_build_dirs` | The build directories given at startup, with source directory, generator, build type, File API status (codemodel present, stale, modified inputs) and `compile_commands.json` location. |
| `get_project_summary` | CMake version, generator, configurations, `project()` hierarchy, targets grouped by type. |
| `list_targets` | Targets filtered by type, name (substring / glob / `/regex/`), project or directory. |
| `get_target` | Everything about one target: definition site, artifacts, dependencies, compile groups (flags, defines, includes, standard, PCH), link/archive fragments, install destinations, sources, optional backtraces. |
| `get_target_dependencies` | Direct or transitive dependencies or dependents of a target. |
| `find_file_targets` | Which targets compile a file (in every given build directory and configuration), with the File API compile settings and the matching `compile_commands.json` entries. Headers fall back to targets whose include directories contain them. |
| `get_compile_commands` | Exact entries of `compile_commands.json` (directory, arguments, original command, output), filtered by file, path pattern, target or configuration; searches the given build directories when only `file` is given. |
| `get_cache_variables` | Cache entries with type, value, help string; filterable. |
| `get_toolchains` | Compilers per language with implicit include/link directories. |
| `get_cmake_inputs` | Files CMake read during configure, glob dependencies, and inputs modified since then. |
| `list_tests` | Tests from `CTestTestfile.cmake`: name, labels, disabled, directory, fixture roles. Capped. Name filters are a substring, glob, or `/regex/`. |
| `get_test` | One test: command, properties, labels, fixtures, dependencies, backtrace. |
| `list_labels` | Each label and how many tests have it. |
| `list_fixtures` | Each fixture and the tests that set it up, require it, or clean it up. |
| `get_test_dependencies` | `DEPENDS` and fixture edges, direct or transitive. |
| `preview_test_run` | Dry run of a ctest selection (`-R`, `-E`, `-L`, `-LE`, exact names, `--rerun-failed`, `-FA`/`-FS`/`-FC`). Returns tests that would run, disabled matches, and fixture tests ctest would add. |
| `get_test_run_summary` | Counts and timing from `Testing/<tag>/Test.xml`. |
| `list_test_results` | Per-test status, time, and exit code. No stdout. Accepts the same selection as `preview_test_run`. |
| `get_test_result` | One test's measurements and stdout, truncated to `maxOutputBytes`. |

`list_build_dirs` includes a `ctest` object: `hasTestfile`, and `testXml` when `Testing/TAG` points at a `Test.xml`.

### Test selection

`preview_test_run` and `list_test_results` take ctest's filters:

- `include` / `exclude` are `-R` / `-E`: one regex each, unanchored and case-sensitive. `^` and `$` anchor. `|` ORs names.
- `labels` / `excludeLabels` are repeatable `-L` / `-LE`. Every regex must match some label on the test (AND). Put `tue|wed` in one entry to OR labels.
- A match does not pull `DEPENDS` tests into the set. It does pull `FIXTURES_SETUP` and `FIXTURES_CLEANUP` for fixtures a selected test requires, unless `-FA`, `-FS`, or `-FC` says otherwise. Disabled matches are listed and do not pull fixtures.
- `engine: "index"` (the default) parses `CTestTestfile.cmake` and does not run ctest. `{` and `}` are literal. `\d`, `\b`, lookaheads, and lazy quantifiers are rejected because ctest's `string(REGEX)` engine does not have them.
- `engine: "ctest"` runs `ctest --show-only=json-v1` with the same flags. Use it when a command still contains a generator expression. Exact name lists need CMake 3.29+ (`--tests-from-file`).
- `explain: true` adds up to 20 names for each reason a test was left out.

`Test.xml` is the file written by `ctest -T Test` (the dashboard test step), not by a plain `ctest` invocation. Pass `testXml` to read a copy from somewhere else. The result index keeps status and timing; stdout is read only for `get_test_result`.

Most tools accept a `buildDir` argument: the absolute path given at startup, or a unique suffix of one
(`build-debug`, `app/build-debug`). Omit it when the server was started with a single build directory.
File paths may be absolute, relative to the working directory, or relative to a build's source directory
when that match is unique. Multi-config generators (Visual Studio, Xcode, Ninja Multi-Config) are supported
through the `configuration` argument.

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
      "compileCommands": [
        {
          "file": "/src/app/tools/main.cpp",
          "directory": "/src/app/build/tools",
          "output": "tools/CMakeFiles/app_cli.dir/main.cpp.o",
          "arguments": ["/usr/bin/c++", "-DCORE_VERSION=3", "-I/src/app/include", "-std=gnu++20", "-Wall",
                        "-o", "CMakeFiles/app_cli.dir/main.cpp.o", "-c", "/src/app/tools/main.cpp"],
          "command": "/usr/bin/c++ -DCORE_VERSION=3 -I/src/app/include -std=gnu++20 -Wall -o CMakeFiles/app_cli.dir/main.cpp.o -c /src/app/tools/main.cpp"
        }
      ]
    }
  ]
}
```

## Requirements

- Node.js 18+
- Build directories produced by CMake 3.14+ (3.20+ for `toolchains`; newer versions add fields such as
  `languageStandard`). CMake itself does not need to be installed where the server runs.

## Installation

```bash
git clone https://github.com/pkp124/cmake-build-model-mcp.git
cd cmake-build-model-mcp
npm install        # also builds dist/
```

## Configuration

The server speaks MCP over stdio.

```text
cmake-build-model-mcp [options] <build-dir>...

  --build-dir <dir>   Build directory that already contains a File API reply (repeatable).
                      Positional arguments are build directories too.
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "cmake-build-model": {
      "command": "node",
      "args": ["/path/to/cmake-build-model-mcp/dist/index.js", "/path/to/build"]
    }
  }
}
```

Pass every build directory you want to query (debug and release, or several projects).

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "cmake-build-model": {
      "command": "node",
      "args": ["/path/to/cmake-build-model-mcp/dist/index.js", "/path/to/build"]
    }
  }
}
```

```bash
claude mcp add cmake-build-model -- node /path/to/cmake-build-model-mcp/dist/index.js /path/to/build
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "cmake-build-model": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/cmake-build-model-mcp/dist/index.js", "/path/to/build"]
    }
  }
}
```

## Notes and limitations

- `INTERFACE` libraries only appear in the codemodel when they have sources (a CMake File API rule).
- `compile_commands.json` is not produced by the Visual Studio and Xcode generators; for those, use the
  File API compile groups returned by `get_target` / `find_file_targets`.
- Test parsing understands the `CTestTestfile.cmake` files CMake generates (`add_test`, `set_tests_properties`,
  `set_directory_properties`, `subdirs`, and `if(CTEST_CONFIGURATION_TYPE MATCHES ...)`). Hand-written logic
  (`foreach`, `include`, other `if` conditions) is skipped and reported in `warnings`.
- Directory `LABELS` are unioned with each test's own labels. Generator expressions are left as written unless
  `preview_test_run` is called with `engine: "ctest"`.

## Development

```bash
npm run build     # compile TypeScript to dist/
npm test          # build + unit and end-to-end tests (needs cmake and a C/C++ compiler; ninja optional)
```

The end-to-end tests copy `test/fixtures/workspace` (two independent projects) into a temporary directory,
configure several build directories with File API queries (the test harness runs CMake, the server never
does), including a Ninja Multi-Config one when `ninja` is available, and drive the compiled server over
stdio with the MCP SDK client, passing those build directories on the command line.

## License

MIT
