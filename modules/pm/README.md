# pm

The package manager of the runtime. It is written in Silk on the Silk standard library and is
part of the runtime executable: `silkjsruntime install`, `add`, `remove`, `update` and `ci` run
[`cli.execute`](src/cli.silk) before the JavaScript engine starts. This package also builds a
small `pm` executable with the same commands, for developing it without building the runtime.

```sh
silk test --root src/tests.silk     # the unit tests
silk run -- install                 # install the package.json of the working directory
```

| Command | What it does |
|---|---|
| `pm install` | Installs what `package.json` lists. The lockfile decides the versions while it matches. |
| `pm install --frozen-lockfile`, `pm ci` | The same, and fails when the lockfile is missing or out of date. |
| `pm add <name>[@range or tag]...` | Adds dependencies and installs them. `-D` for development, `-O` for optional, `-E` for an exact version. |
| `pm remove <name>...` | Takes dependencies out and removes what nothing needs any more. |
| `pm update [name]...` | Moves the named packages, or all, to the newest versions the ranges allow. |
| `pm run <script> [argument]...` | Runs a script of `package.json`, between its `pre` and `post` scripts when it has them. Without a name it lists the scripts. `-r` runs it in every package of the workspace. |
| `pm exec <command> [argument]...` | Runs a command of the dependencies. |
| `pm dlx <name>[@range or tag] [argument]...` | Runs the command of a package the project does not have. |

An install resolves the dependencies against the registry, downloads what the store at
`$SILKJS_STORE` (or `~/.silkjs/store`) does not have, and links an isolated `node_modules`: each
package once under `node_modules/.sjs`, with its dependencies as sibling links. Tarballs are
unpacked on a thread pool while later ones still download, and a resolution starts the downloads
of the packages it has settled while it still asks for the metadata of the rest. What the graph
no longer has is removed from `node_modules`.

The resolved graph is written to `sjs.lock`, one line per package. The next install reads it and
asks the registry nothing when it still matches `package.json`. The graph holds the packages of
every platform, so the file is the same on every machine; the install skips what the host cannot
run.

A package gets its peer dependencies from what is above it: the nearest package, up to the
project, that depends on something under that name. When the same version of a package is used
with different peers, each use is a node of its own in the graph, with its own entry in the
lockfile and its own directory, named after the peers: `node_modules/.sjs/plugin@1.0.0_host@2.1.0`.
A peer nothing above provides is installed for the package that asks, and an optional one is
left out.

## Scripts and commands

`run` and `exec` work in the directory of the package, with `node_modules/.bin` of the package
and of the root of the workspace first on `PATH`, the input and the output of the terminal, and
the variables scripts read (`npm_lifecycle_event`, `npm_package_name`, `INIT_CWD` and the others
named below). They end with the exit code of what ran. The words after the script name go to
the script as they are, each as one argument; a `--` before them is left out. In a workspace,
`--filter <name>` and `-w` before the script name choose the package, and `run -r <script>` runs
the script in every package that has it, a package after the ones it depends on, until one fails.

`dlx` installs the package in a project of its own in the store, `dlx/<name>@<range>`, and runs
its command in the working directory: the one command it has, or the one named like the package.
A range that is one version is installed once; anything else is resolved again each time, so
`dlx create-thing` gets today's `latest`. Install scripts do not run for it.

The last place on `PATH` is the `commands` directory of the store. The runtime puts itself there
under the name `node`, so a script that calls `node` works on a machine that has the runtime
alone, and a Node.js on `PATH` comes first where there is one. Called as `node`, the runtime has
no package manager commands: `node install` runs the file `install`.

## Install scripts

A package can have `preinstall`, `install` and `postinstall` scripts, which build what it needs
on the machine. They are commands the author of the package wrote, so none of them runs unless
the root project names the package in `allowBuilds` of its `package.json`:

```json
{ "allowBuilds": { "esbuild": true, "sharp@0.33.5": true, "core-js": false } }
```

`true` runs the scripts, for every version or for the one after `@`. A package that has scripts
and is not named is listed when it is installed; `false` leaves it out of that list.

An allowed package is copied from the store and not linked, so its scripts change the copy of
the project alone. The scripts run with `sh` in the directory of the package when everything is
linked, a package after its dependencies, with the commands of its dependencies and of the
project on `PATH` and the `npm_lifecycle_event`, `npm_package_name`, `npm_package_version`,
`npm_package_json`, `npm_config_user_agent` and `INIT_CWD` variables. A package with a
`binding.gyp` and no `install` script runs `node-gyp rebuild`, which has to be on `PATH`. A
script that fails stops the install with the end of what it wrote, and the next install tries
again. The scripts of the project's own packages do not run yet.

`add` and `remove` edit `package.json` in its text: the formatting and the order of the keys
stay as they are.

## Workspaces

A `package.json` with `workspaces` is the root of a workspace: the field lists patterns for the
directories of its packages, such as `["packages/*", "apps/**", "!apps/legacy"]`, or holds that
list under `packages`. The packages are installed together:

- There is one `sjs.lock` and one `node_modules/.sjs`, at the root. Each package has its own
  `node_modules` with links into it, so it can load what it declares and nothing else.
- A dependency written `workspace:*`, `workspace:^`, `workspace:~` or `workspace:<range>` is
  another package of the workspace, by name, and becomes a link to its directory. A range has
  to allow the version of that package. `workspace:<name>@*` links it under another name.
- `catalog:` as a range stands for the range the root project keeps for that name, in `catalog`
  or `workspaces.catalog`; `catalog:<name>` reads `catalogs.<name>`. The lockfile records the
  catalogs, so changing one resolves again.
- Every command works from the directory of any package and installs for the whole workspace.
  `add`, `remove`, `run` and `exec` work on the package they are run in; `--filter <name>`
  (`-F`) picks another one by name, and `-w` the root project.
- `.npmrc` is read from the home directory, then the root of the workspace, then the working
  directory.

## Layout

- `src/pkg` knows nothing about npm: versions and ranges, the content-addressable store,
  integrity checks, name interning, file linking, a one-pass JSON walker and an editor for JSON
  text. A package manager for another ecosystem can use it
  as is.
- `src/npm` is what is specific to the npm ecosystem: manifests, registry metadata, the registry
  client, `.npmrc`, workspaces, the resolver, the lockfile, the `node_modules` layout, install scripts and
  the commands.
