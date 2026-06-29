#!/usr/bin/env python3
"""Static server for the portrait simulator with no-cache JS during dev.

Also serves ../field-recorder-viewer/ at /field-recorder-viewer/ so the
browse link works without a separate server.
"""

from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
import sys
import urllib.parse

SIM_ROOT = os.path.dirname(os.path.abspath(__file__))
VIEWER_ROOT = os.path.join(os.path.dirname(SIM_ROOT), "field-recorder-viewer")
PORT = int(os.environ.get("PORT", "5179"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=SIM_ROOT, **kwargs)

    def translate_path(self, path):
        path = path.split("?", 1)[0]
        path = path.split("#", 1)[0]
        path = urllib.parse.unquote(path)
        parts = [p for p in path.split("/") if p]

        if parts and parts[0] == "field-recorder-viewer":
            root = VIEWER_ROOT
            parts = parts[1:]
        elif parts and parts[0] == "portrait-simulator":
            root = SIM_ROOT
            parts = parts[1:]
        else:
            root = SIM_ROOT

        if not parts:
            return os.path.join(root, "index.html")

        joined = os.path.normpath(os.path.join(root, *parts))
        root_norm = os.path.normpath(root)
        if joined != root_norm and not joined.startswith(root_norm + os.sep):
            return os.path.join(root, "index.html")
        if os.path.isdir(joined):
            return os.path.join(joined, "index.html")
        return joined

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.endswith((".js", ".html", ".css", ".json")):
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(SIM_ROOT)
    with ThreadingHTTPServer(("", PORT), Handler) as httpd:
        print(f"Portrait simulator at http://localhost:{PORT}", file=sys.stderr)
        print(f"Field recorder viewer at http://localhost:{PORT}/field-recorder-viewer/", file=sys.stderr)
        print("Press Ctrl+C to stop.", file=sys.stderr)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopped.", file=sys.stderr)
