# pm

The package manager of the runtime. It is written in Silk on the Silk standard library and will
run inside the runtime executable, as `install`, `add`, `run` and the other commands, before the
JavaScript engine starts. Until that is wired in, this package builds a small `pm` executable for
development.

```sh
silk test --root src/tests.silk     # the unit tests
silk run -- fetch is-odd '^3'       # resolve, download, check and unpack one package
```

`pm fetch` writes to the store at `$SILKJS_STORE`, or `~/.silkjs/store`.

## Layout

- `src/pkg` knows nothing about npm: versions and ranges, the content-addressable store,
  integrity checks, a one-pass JSON walker. A package manager for another ecosystem can use it
  as is.
- `src/npm` is what is specific to the npm ecosystem: registry metadata, the registry client and
  `.npmrc`.
