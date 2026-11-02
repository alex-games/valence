#!/usr/bin/env python3
"""Serve vm/runtime for the v86 harness.

The page addresses everything as `/vm/...`; this strips that prefix and serves
the runtime directory. It is threaded (v86 fetches many 9p blobs) and it sets the
MIME types the wasm and the 9p loader need.

    python3 vm/serve.py [port] [root]
"""
from __future__ import annotations

import http.server
import os
import socketserver
import sys


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def translate_path(self, path: str) -> str:
        if path.startswith("/vm/"):
            path = path[3:]
        elif path == "/vm":
            path = "/"
        return super().translate_path(path)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stdout.write("[vm] %s %s\n" % (self.address_string(), fmt % args))
        sys.stdout.flush()


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18446
    root = sys.argv[2] if len(sys.argv) > 2 else "vm/runtime"
    Handler.extensions_map.update({
        ".wasm": "application/wasm",
        ".js": "application/javascript",
        ".json": "application/json",
        ".bin": "application/octet-stream",
        ".zst": "application/octet-stream",
        ".svg": "image/svg+xml",
    })
    os.chdir(root)
    print(f"serving {root} at http://127.0.0.1:{port}/vm/index.html", flush=True)
    Server(("127.0.0.1", port), Handler).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
