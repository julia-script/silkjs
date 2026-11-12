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

`add` and `remove` edit `package.json` in its text: the formatting and the order of the keys
stay as they are.

## Layout

- `src/pkg` knows nothing about npm: versions and ranges, the content-addressable store,
  integrity checks, name interning, file linking, a one-pass JSON walker and an editor for JSON
  text. A package manager for another ecosystem can use it
  as is.
- `src/npm` is what is specific to the npm ecosystem: manifests, registry metadata, the registry
  client, `.npmrc`, the resolver, the lockfile, the `node_modules` layout and the commands.
