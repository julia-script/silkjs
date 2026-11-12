# pm

The package manager of the runtime. It is written in Silk on the Silk standard library and will
run inside the runtime executable, as `install`, `add`, `run` and the other commands, before the
JavaScript engine starts. Until that is wired in, this package builds a small `pm` executable for
development.

```sh
silk test --root src/tests.silk     # the unit tests
silk run -- install                 # install the package.json of the working directory
```

`pm install` resolves the dependencies against the registry, downloads what the store at
`$SILKJS_STORE` (or `~/.silkjs/store`) does not have, and links an isolated `node_modules`: each
package once under `node_modules/.sjs`, with its dependencies as sibling links. Tarballs are
unpacked on a thread pool while later ones still download.

The resolved graph is written to `sjs.lock`, one line per package. The next install reads it and
asks the registry nothing when it still matches `package.json`. The graph holds the packages of
every platform, so the file is the same on every machine; the install skips what the host cannot
run. `pm install --frozen-lockfile` fails when the lockfile is missing or out of date.

## Layout

- `src/pkg` knows nothing about npm: versions and ranges, the content-addressable store,
  integrity checks, name interning, file linking, a one-pass JSON walker. A package manager for another ecosystem can use it
  as is.
- `src/npm` is what is specific to the npm ecosystem: manifests, registry metadata, the registry
  client, `.npmrc`, the resolver and the `node_modules` layout.
