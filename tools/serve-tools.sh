#!/usr/bin/env python3
"""Serve tools/ so portrait-simulator and field-recorder-viewer share one port."""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(os.environ.get("PORT", "5179"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.endswith((".js", ".html", ".css", ".json")):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(ROOT)
    with ThreadingHTTPServer(("", PORT), Handler) as httpd:
        print(f"Tools server at http://localhost:{PORT}", file=sys.stderr)
        print(f"  Simulator: http://localhost:{PORT}/portrait-simulator/", file=sys.stderr)
        print(f"  Viewer:    http://localhost:{PORT}/field-recorder-viewer/", file=sys.stderr)
        print("Press Ctrl+C to stop.", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.", file=sys.stderr)
