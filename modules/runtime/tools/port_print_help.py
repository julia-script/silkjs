#!/usr/bin/env python3
"""usage: port_print_help.py [NODE_SOURCE_DIR]
Copy Node v24.22.1's lib/internal/main/print_help.js into ext/node with the runtime's bindings."""
import sys
from pathlib import Path
NODE = Path(sys.argv[1] if len(sys.argv) > 1 else '/root/setup/node-src') / 'lib'
EXT = Path(__file__).resolve().parent.parent / 'ext' / 'node'
name = 'internal/main/print_help.js'
text = (NODE / name).read_text()
for old, new in [
    ("} = primordials;\n", "} = require('internal/per_context/primordials');\nconst { internalBinding } = require('internal/bindings');\n"),
    ("const {\n  prepareMainThreadExecution,\n  markBootstrapComplete,\n} = require('internal/process/pre_execution');\n\n", ""),
    # The runtime's bootstrap prepares the main thread, then calls print for --help.
    ("prepareMainThreadExecution();\n\nmarkBootstrapComplete();\n\nprint(process.stdout);\n", "module.exports = { print };\n"),
]:
    if old not in text: sys.exit(f'{name}: missing {old!r}')
    text = text.replace(old, new)
(EXT / name).write_text(f'// Adapted from Node.js v24.22.1 lib/{name} for Silk.\n' + text)
