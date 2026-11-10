# lib-silkjs

SilkJS, a native [Silk](https://github.com/silk-lang/silk) port of QuickJS, and a Node-compatible
runtime built on it.

| Module | Package | What it is |
| --- | --- | --- |
| [`modules/engine`](modules/engine) | `silkjs` | The JavaScript engine, its embedding API and the `silkjs` command line |
| [`modules/runtime`](modules/runtime) | `silkjsruntime` | The Node-compatible runtime; depends on the engine by path |

Each module is its own Silk package with its own `silk.toml`, `build/` directory and tasks. Run
Silk commands from the module's directory:

```sh
cd modules/engine
silk use              # install the pinned Silk release
silk task             # list the engine's tasks
silk task check       # the correctness gate

cd ../runtime
silk task build       # the runtime executable, build/silkjsruntime
```

The runtime history was merged from
[julia-script/silkjsruntime](https://github.com/julia-script/silkjsruntime); `git log --follow`
reaches commits from before the move.
