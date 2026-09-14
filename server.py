#!/usr/bin/env python3
"""没装 Node 时的备用静态服务器：python server.py [端口]

只提供 HTTP。手机想用摄像头当接收端需要 HTTPS，请改用 node server.js --https。
"""
import http.server
import socket
import socketserver
import sys
from functools import partial

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".json": "application/json",
    }

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # 别把控制台刷满


def local_ips():
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return ips


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("", PORT), partial(Handler, directory=".")) as httpd:
        print(f"\n  HTTP   http://localhost:{PORT}")
        for ip in local_ips():
            print(f"         http://{ip}:{PORT}   (摄像头在此地址下不可用)")
        print("\n  手机要当接收端请用：node server.js --https")
        print("\n  Ctrl+C 退出\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
