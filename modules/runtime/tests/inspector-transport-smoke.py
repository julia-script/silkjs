#!/usr/bin/env python3
"""External client, never a guest execution fallback.

Start Silk with --inspect-brk=127.0.0.1:0 and a long-lived guest, then run:
  python3 tests/inspector-transport-smoke.py ws://127.0.0.1:PORT/UUID --busy --pause
The default checks transport plus Runtime.enable/evaluate/runIfWaitingForDebugger.
--transport-only omits CDP semantic assertions (the parent adapter owns those).
--busy and --pause additionally prove independent discovery and ping progress.
No third-party Python dependencies. Every socket has a bounded deadline.
"""
import argparse
import base64
import hashlib
from http.client import HTTPConnection
import json
import os
import socket
import struct
import time
from urllib.parse import urlsplit


class WebSocket:
    def __init__(self, endpoint):
        self.endpoint = endpoint
        self.sock = socket.create_connection((endpoint.hostname, endpoint.port), 5)
        self.sock.settimeout(5)
        self.buffer = bytearray()
        self.events = []
        self.replies = {}
        self.sequence = 0
        key = base64.b64encode(os.urandom(16)).decode()
        request = (f"GET {endpoint.path} HTTP/1.1\r\nHost: {endpoint.netloc}\r\n"
                   "Connection: keep-alive, Upgrade\r\nUpgrade: websocket\r\n"
                   f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n")
        self.sock.sendall(request.encode())
        while b"\r\n\r\n" not in self.buffer:
            block = self.sock.recv(4096)
            assert block, "EOF before upgrade response"
            self.buffer.extend(block)
            assert len(self.buffer) <= 16384, "unbounded HTTP response"
        raw, remaining = bytes(self.buffer).split(b"\r\n\r\n", 1)
        self.buffer = bytearray(remaining)
        lines = raw.decode().split("\r\n")
        assert lines[0] == "HTTP/1.1 101 Switching Protocols", lines[0]
        headers = dict(line.lower().split(": ", 1) for line in lines[1:])
        expected = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        # Preserve case for the base64 value.
        original_headers = dict((line.split(":", 1)[0].lower(), line.split(":", 1)[1].strip()) for line in lines[1:])
        assert original_headers["sec-websocket-accept"] == expected
        assert headers["upgrade"] == "websocket"

    def close(self):
        self.sock.close()

    def send_frame(self, opcode, body=b"", fin=True, masked=True):
        header = bytes([(128 if fin else 0) | opcode])
        mask_bit = 128 if masked else 0
        length = len(body)
        if length < 126:
            header += bytes([mask_bit | length])
        elif length <= 65535:
            header += bytes([mask_bit | 126]) + struct.pack("!H", length)
        else:
            header += bytes([mask_bit | 127]) + struct.pack("!Q", length)
        if masked:
            mask = os.urandom(4)
            header += mask
            body = bytes(value ^ mask[index % 4] for index, value in enumerate(body))
        self.sock.sendall(header + body)

    def read(self, count):
        while len(self.buffer) < count:
            block = self.sock.recv(max(4096, count - len(self.buffer)))
            assert block, "unexpected WebSocket EOF"
            self.buffer.extend(block)
        data = bytes(self.buffer[:count])
        del self.buffer[:count]
        return data

    def receive(self):
        first, second = self.read(2)
        assert not second & 128, "server frames must be unmasked"
        assert not first & 112, "unexpected RSV bits"
        assert first & 128, "smoke expects complete server frames"
        opcode, length = first & 15, second & 127
        if length == 126:
            length = struct.unpack("!H", self.read(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self.read(8))[0]
        assert length <= 4 * 1024 * 1024, "unbounded server frame"
        body = self.read(length)
        if opcode == 1:
            message = json.loads(body)
            if "id" in message:
                self.replies[message["id"]] = message
            else:
                self.events.append(message)
        elif opcode == 9:
            self.send_frame(10, body)
        return opcode, body

    def command(self, method, params=None, fragmented=False):
        self.sequence += 1
        body = json.dumps({"id": self.sequence, "method": method, "params": params or {}}, ensure_ascii=False).encode()
        if fragmented:
            split = len(body) // 2
            self.send_frame(1, body[:split], fin=False)
            self.send_frame(9, b"between-fragments")
            self.send_frame(0, body[split:])
        else:
            self.send_frame(1, body)
        return self.sequence

    def result(self, identifier):
        deadline = time.monotonic() + 8
        while identifier not in self.replies:
            assert time.monotonic() < deadline, f"missing CDP response {identifier}"
            opcode, body = self.receive()
            assert opcode != 8, f"unexpected close {body!r}"
        response = self.replies.pop(identifier)
        assert "error" not in response, response
        return response["result"]

    def event(self, method):
        deadline = time.monotonic() + 8
        while True:
            for index, event in enumerate(self.events):
                if event.get("method") == method:
                    return self.events.pop(index)
            assert time.monotonic() < deadline, f"missing event {method}"
            opcode, body = self.receive()
            assert opcode != 8, body

    def ping(self, payload=b"silk-transport-ping"):
        self.send_frame(9, payload)
        deadline = time.monotonic() + 5
        while True:
            opcode, body = self.receive()
            if opcode == 10 and body == payload:
                return
            assert opcode != 8, body
            assert time.monotonic() < deadline, "missing pong"


def http(endpoint, path, host=None, origin=None):
    connection = HTTPConnection(endpoint.hostname, endpoint.port, timeout=3)
    headers = {"Host": host or endpoint.netloc}
    if origin is not None:
        headers["Origin"] = origin
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def discovery(endpoint):
    for path in ("/json", "/json/list"):
        status, body = http(endpoint, path)
        assert status == 200, (path, status, body)
        entries = json.loads(body)
        assert len(entries) == 1
        assert entries[0]["webSocketDebuggerUrl"] == endpoint.geturl(), entries
        assert entries[0]["id"] == endpoint.path[1:]
        assert entries[0]["type"] == "node"
    status, body = http(endpoint, "/json/version")
    assert status == 200 and json.loads(body)["Protocol-Version"] == "1.3"


def protocol_rejections(endpoint):
    for opcode, body, fin, masked, expected in (
        (1, b"{}", True, False, 1002),
        (0, b"{}", True, True, 1002),
        (9, b"ping", False, True, 1002),
        (2, b"binary", True, True, 1003),
        (1, b"\xff", True, True, 1007),
        (8, b"x", True, True, 1002),
    ):
        ws = WebSocket(endpoint)
        try:
            ws.send_frame(opcode, body, fin, masked)
            deadline = time.monotonic() + 5
            while True:
                received, payload = ws.receive()
                if received == 8:
                    assert len(payload) >= 2 and struct.unpack("!H", payload[:2])[0] == expected, (expected, payload)
                    break
                assert time.monotonic() < deadline, "missing protocol close"
        finally:
            ws.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="exact ws:// endpoint printed by Silk")
    parser.add_argument("--transport-only", action="store_true")
    parser.add_argument("--busy", action="store_true")
    parser.add_argument("--pause", action="store_true")
    args = parser.parse_args()
    endpoint = urlsplit(args.url)
    assert endpoint.scheme == "ws" and endpoint.hostname and endpoint.port and endpoint.path
    assert not args.transport_only or not (args.busy or args.pause)
    discovery(endpoint)
    assert http(endpoint, "/json", host=f"rebind.attacker.invalid:{endpoint.port}")[0] == 403
    assert http(endpoint, "/json", origin="https://attacker.invalid")[0] == 403
    assert http(endpoint, "/not-the-endpoint")[0] == 404
    protocol_rejections(endpoint)
    ws = WebSocket(endpoint)
    try:
        ws.ping()
        if not args.transport_only:
            ws.result(ws.command("Runtime.enable", fragmented=True))
            ws.result(ws.command("Runtime.runIfWaitingForDebugger"))
            evaluated = ws.result(ws.command("Runtime.evaluate", {"expression": "40 + 2", "returnByValue": True}))
            assert evaluated["result"]["value"] == 42, evaluated
            # Extended 16/64-bit lengths and fragmented UTF-8 reach the adapter.
            for length in (200, 66000):
                expression = "/*" + "x" * length + "*/ 'π'"
                result = ws.result(ws.command("Runtime.evaluate", {"expression": expression, "returnByValue": True}, fragmented=length == 200))
                assert result["result"]["value"] == "π", result
            if args.busy:
                identifier = ws.command("Runtime.evaluate", {"expression": "(() => { const end = Date.now() + 2500; while (Date.now() < end) {} return 42; })()", "returnByValue": True})
                time.sleep(0.1)
                started = time.monotonic()
                discovery(endpoint)
                ws.ping(b"busy-owner")
                assert time.monotonic() - started < 1.5, "discovery/ping blocked on busy owner"
                assert ws.result(identifier)["result"]["value"] == 42
            if args.pause:
                ws.result(ws.command("Debugger.enable"))
                pause_id = ws.command("Debugger.pause")
                ws.event("Debugger.paused")
                discovery(endpoint)
                ws.ping(b"paused-owner")
                ws.result(ws.command("Debugger.resume"))
                ws.result(pause_id)
                ws.event("Debugger.resumed")
        ws.send_frame(8, struct.pack("!H", 1000) + b"smoke complete")
        deadline = time.monotonic() + 5
        while True:
            opcode, body = ws.receive()
            if opcode == 8:
                assert body == struct.pack("!H", 1000) + b"smoke complete", body
                break
            assert time.monotonic() < deadline, "missing close echo"
    finally:
        ws.close()
    print("inspector transport smoke passed" + (" (transport only)" if args.transport_only else " (CDP integrated)"))


if __name__ == "__main__":
    main()
