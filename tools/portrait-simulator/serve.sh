#!/usr/bin/env python3
"""Static server for the portrait simulator with no-cache JS during dev."""

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
        if path.endswith((".js", ".html", ".css")):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(ROOT)
    with ThreadingHTTPServer(("", PORT), Handler) as httpd:
        print(f"Portrait simulator at http://localhost:{PORT}", file=sys.stderr)
        print("Press Ctrl+C to stop.", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.", file=sys.stderr)
