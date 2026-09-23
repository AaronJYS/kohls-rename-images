"""Serve the local web app without caching development files."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class DevelopmentHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Workers and imported modules must refresh along with the page.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    web_root = Path(__file__).resolve().parent / "web"
    handler = partial(DevelopmentHandler, directory=str(web_root))
    with ThreadingHTTPServer(("127.0.0.1", 4173), handler) as server:
        print("JYS file tools: http://127.0.0.1:4173/ (caching disabled)", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
