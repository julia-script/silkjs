'use strict';
// Network handles on the runtime reactor: TCP echo with backpressure, half close, a refused
// connect, a chosen local port, Unix sockets, UDP, unref, and the handle list. Run it with node and
// with the runtime; the outputs must match.
const assert = require('assert');
const net = require('net');
const dgram = require('dgram');
const path = require('path');
const fs = require('fs');
const os = require('os');

const results = [];
const steps = [];
const step = (name, run) => steps.push({ name, run });
const next = () => {
  const entry = steps.shift();
  if (!entry) { console.log(JSON.stringify(results)); return; }
  entry.run(value => { results.push([entry.name, value]); next(); });
};

step('large-echo', done => {
  const size = 8 * 1024 * 1024;
  const server = net.createServer(socket => socket.pipe(socket));
  server.listen(0, '127.0.0.1', () => {
    const client = net.connect(server.address().port, '127.0.0.1');
    const payload = Buffer.alloc(size, 7);
    let received = 0;
    let drained = false;
    client.on('data', chunk => { received += chunk.length; if (received === size) client.end(); });
    client.on('drain', () => { drained = true; });
    client.on('close', () => server.close(() => done([received, drained || client.write.length > 0])));
    client.write(payload);
  });
});

step('half-close', done => {
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', value => { text += value; });
    socket.on('end', () => socket.end(`got:${text}`));
  });
  server.listen(0, '127.0.0.1', () => {
    const client = net.connect({ port: server.address().port, host: '127.0.0.1', allowHalfOpen: true }, () => client.end('ping'));
    let reply = '';
    client.setEncoding('utf8');
    client.on('data', value => { reply += value; });
    client.on('end', () => client.end());
    client.on('close', () => server.close(() => done(reply)));
  });
});

step('refused', done => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => {
      const client = net.connect(port, '127.0.0.1');
      client.on('error', error => done([error.code, error.syscall, error.port === port]));
    });
  });
});

step('local-port', done => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const localPort = probe.address().port;
    probe.close(() => {
      const server = net.createServer(socket => {
        const seen = socket.remotePort === localPort;
        socket.end();
        socket.on('close', () => server.close(() => done([seen, socket.remoteAddress])));
      });
      server.listen(0, '127.0.0.1', () => {
        const client = net.connect({ port: server.address().port, host: '127.0.0.1', localAddress: '127.0.0.1', localPort });
        client.on('data', () => {});
        client.on('error', error => done(error.code));
      });
    });
  });
});

step('addresses', done => {
  const server = net.createServer(socket => {
    const seen = [socket.address().family, socket.address().address, socket.remoteFamily, typeof socket.remotePort];
    socket.end();
    socket.on('close', () => server.close(() => done(seen)));
  });
  server.listen(0, '127.0.0.1', () => {
    const client = net.connect(server.address().port, '127.0.0.1');
    client.on('data', () => {});
  });
});

step('unix', done => {
  const file = path.join(os.tmpdir(), `net-reactor-${process.pid}.sock`);
  try { fs.unlinkSync(file); } catch {}
  const server = net.createServer(socket => { socket.end('unix-ok'); });
  server.listen(file, () => {
    const named = server.address() === file;
    const client = net.connect(file);
    let text = '';
    client.setEncoding('utf8');
    client.on('data', value => { text += value; });
    client.on('close', () => server.close(() => { try { fs.unlinkSync(file); } catch {} done([named, text]); }));
  });
});

step('udp', done => {
  const server = dgram.createSocket('udp4');
  const client = dgram.createSocket('udp4');
  server.on('message', (message, remote) => {
    server.send(Buffer.from(`re:${message}`), remote.port, remote.address);
  });
  client.on('message', message => {
    const text = message.toString();
    client.close();
    server.close(() => done([text]));
  });
  server.bind(0, '127.0.0.1', () => {
    client.bind(0, '127.0.0.1', () => {
      client.setTTL(32);
      client.setBroadcast(true);
      client.send('hello', server.address().port, '127.0.0.1');
    });
  });
});

step('udp-connected', done => {
  const server = dgram.createSocket('udp4');
  const client = dgram.createSocket('udp4');
  server.on('message', message => { client.close(); server.close(() => done([message.toString(), connected])); });
  let connected = false;
  server.bind(0, '127.0.0.1', () => {
    client.connect(server.address().port, '127.0.0.1', () => {
      connected = client.remoteAddress().port === server.address().port;
      client.send('connected');
    });
  });
});

step('unref', done => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1', () => {
    server.unref();
    const types = process.getActiveResourcesInfo().filter(type => type.includes('TCP'));
    server.ref();
    server.close(() => done(types));
  });
});

step('destroy-pending-write', done => {
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.on('data', () => {}); });
  server.listen(0, '127.0.0.1', () => {
    const client = net.connect(server.address().port, '127.0.0.1', () => {
      client.write(Buffer.alloc(32 * 1024 * 1024), error => {
        server.close(() => done(error ? error.code : 'written'));
      });
      setImmediate(() => client.destroy());
    });
    client.on('error', () => {});
  });
});

next();
