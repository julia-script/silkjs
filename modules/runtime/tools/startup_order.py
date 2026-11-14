#!/usr/bin/env python3
"""Writes tools/startup-order.txt and tools/server-order.txt: the functions a start of
the runtime runs, then the rest that HTTP and HTTPS servers run.

Usage: python3 tools/startup_order.py path/to/silkjsruntime [callgrind.out ...]

Runs the given release executable under valgrind's callgrind on a few small starts (an
empty script, one console.log, a local require, a timer), each from the executable's
heap image, and lists every function a run entered, in the order callgrind first names
them. tools/build.py hands the list to the linker, which places these
functions together (see startup_order there). Function names are hashes of what a
function is, not of where it lands, so the list stays right across builds; a name that
no longer exists is ignored by the linker. Run this again when startup changes shape.

The server list comes from one script that serves node:http, node:https (a certificate
made with the openssl command) and silk:serve requests to its own keep-alive client,
then from any callgrind profiles given after the executable (the committed list merged
an Express-over-HTTPS server, a node:http server and a serve() server, each under
`wrk -c8`). The server list names every function, C ones too (OpenSSL's), since a
server spends much of its time there.
"""

import pathlib
import re
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
NAME = re.compile(r'^c?fn=\(\d+\) (silk_[0-9a-f]{32})$')
ANY_NAME = re.compile(r'^c?fn=\(\d+\) ([A-Za-z_][A-Za-z0-9_.]*)$')
SCRIPTS = ['', 'console.log("hello");\n', "require('./dependency.js');\n", 'setTimeout(() => {}, 1);\n']
SERVER = r'''
const fs = require('fs'), http = require('http'), https = require('https');
const tls = { key: fs.readFileSync(__dirname + '/key.pem'), cert: fs.readFileSync(__dirname + '/cert.pem') };
async function drive(module, server, options) {
  await new Promise(resolve => server.listen(0, resolve));
  const agent = new module.Agent({ keepAlive: true, maxSockets: 4 });
  const one = () => new Promise((resolve, reject) => module.get({ port: server.address().port, agent, ...options }, res => {
    res.resume(); res.on('end', resolve);
  }).on('error', reject));
  for (let i = 0; i < 100; i++) await Promise.all([one(), one(), one(), one()]);
  agent.destroy(); server.close();
}
(async () => {
  await drive(http, http.createServer((req, res) => res.end('ok')), {});
  await drive(https, https.createServer(tls, (req, res) => { res.setHeader('content-type', 'text/plain'); res.end('ok'); }), { rejectUnauthorized: false });
  const { serve } = require('silk:serve');
  const server = serve({ port: 0, fetch() { return new Response('ok'); } });
  for (let i = 0; i < 100; i++) await Promise.all([1, 2, 3, 4].map(() => fetch(`http://localhost:${server.port}/`).then(r => r.text())));
  server.stop?.();
})();
'''


def named(profile, pattern, seen, order):
    for line in profile.read_text().splitlines():
        match = pattern.match(line)
        if match and match.group(1) not in seen:
            seen.add(match.group(1))
            order.append(match.group(1))


def entered(executable, script, directory, seen, order, pattern=NAME):
    source = directory / 'main.js'
    source.write_text(script)
    (directory / 'dependency.js').write_text('module.exports = 1;\n')
    profile = directory / 'callgrind.out'
    subprocess.run(
        ['valgrind', '--tool=callgrind', f'--callgrind-out-file={profile}', str(executable), str(source)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    named(profile, pattern, seen, order)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    executable = pathlib.Path(sys.argv[1]).resolve()
    seen, order, server = set(), [], []
    with tempfile.TemporaryDirectory() as directory:
        directory = pathlib.Path(directory)
        for script in SCRIPTS:
            entered(executable, script, directory, seen, order)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
                        '-keyout', str(directory / 'key.pem'), '-out', str(directory / 'cert.pem')],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        entered(executable, SERVER, directory, seen, server, ANY_NAME)
    for extra in sys.argv[2:]:
        named(pathlib.Path(extra), ANY_NAME, seen, server)
    (ROOT / 'tools/startup-order.txt').write_text('\n'.join(order) + '\n')
    (ROOT / 'tools/server-order.txt').write_text('\n'.join(server) + '\n')
    print(f'{len(order)} startup functions, {len(server)} more for servers')


if __name__ == '__main__':
    main()
