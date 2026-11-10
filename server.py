"""Run the recording project with: python server.py"""
from __future__ import annotations

import argparse
import json
import os
import math
import shutil
import zipfile
import subprocess
import sys
import tempfile
import threading
import hmac
import re
import signal
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

from presentations import store as presentations, MAX_BYTES

ROOT = Path(__file__).resolve().parent


def save_upload(source, path, remaining):
    with path.open("wb") as stream:
        while remaining:
            chunk = source.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise ValueError("Upload was interrupted.")
            stream.write(chunk)
            remaining -= len(chunk)


def encode_video(source, target, offset_ms, frames, audio, mirror=False):
    import imageio_ffmpeg

    # A shared 30 fps timeline gives both tracks the same exact frame count.
    duration = frames / 30
    delay_frames = round(offset_ms * 30 / 1000)
    pad_mode = "clone" if audio else "add"
    video = (
        "setpts=PTS-STARTPTS,fps=30,"
        f"tpad=start={delay_frames}:start_mode={pad_mode}:stop={frames}:stop_mode={pad_mode},"
        f"trim=end_frame={frames},setpts=N,"
        "pad=ceil(iw/2)*2:ceil(ih/2)*2"
    )
    if mirror:
        video += ",hflip"
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-y", "-i", str(source)]
    command += [
        "-map", "0:v:0", "-vf", video,
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-r", "30", "-fps_mode", "cfr",
    ]
    if audio:
        filters = "aresample=async=1:first_pts=0"
        filters += f",adelay={offset_ms}:all=1,apad,atrim=duration={duration:.9f}"
        command += [
            "-map", "0:a:0", "-af",
            filters,
            "-c:a", "aac", "-b:a", "192k",
        ]
    else:
        command += ["-an"]
    command += ["-movflags", "+faststart", str(target)]
    result = subprocess.run(command, capture_output=True)
    if result.returncode:
        raise RuntimeError("Could not encode " + target.name + ": " + result.stderr.decode(errors="replace")[-400:])


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def authorized(self):
        token = os.environ.get("CPE_DESKTOP_TOKEN")
        if not token:
            return True  # Retain the original browser development mode.
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
            supplied = cookie.get("cpe-session")
            valid = supplied and hmac.compare_digest(supplied.value, token)
        except Exception:
            valid = False
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            valid = False
        if not valid:
            self.send_error(403)
        return bool(valid)

    def do_HEAD(self):
        # Avoid the inherited handler exposing files outside the public asset list.
        self.send_error(405)

    def do_GET(self):
        if not self.authorized():
            return
        path = urlsplit(self.path).path
        page = re.fullmatch(r'/api/presentations/([a-f0-9]{32})/pages/([1-9][0-9]{0,2})\.png', path)
        if page:
            try:
                thumbnail = parse_qs(urlsplit(self.path).query).get('thumbnail') == ['1']
                payload = presentations.page(page[1], int(page[2]), thumbnail=thumbnail)
                self.send_response(200)
                self.send_header('Content-Type', 'image/png')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            except KeyError:
                self.reply(404, {'error': 'Presentation page not found.'})
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception:
                self.reply(422, {'error': 'This slide could not be displayed. Reopen the presentation and try again.'})
            return
        assets = {
            "/", "/index.html", "/styles.css", "/app.js",
            "/camera-effects.js", "/camera-effects-worker.js", "/effects-panel.js",
            "/host-name.js", "/teleprompter.js", "/teleprompter.css", "/teleprompter.html",
            "/presentations.js", "/presentations.css",
            "/models/selfie_multiclass_256x256.tflite",
            "/models/face_landmarker.task", "/vendor/mediapipe/vision_bundle.mjs",
            "/vendor/mediapipe/wasm/vision_wasm_internal.js",
            "/vendor/mediapipe/wasm/vision_wasm_internal.wasm",
            "/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js",
            "/vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm",
        }
        if path not in assets:
            self.send_error(404)
            return
        super().do_GET()

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'")
        super().end_headers()

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if not self.authorized():
            return
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            return self.reply(403, {"error": "Request must come from this local project."})
        removal = re.fullmatch(r'/api/presentations/([a-f0-9]{32})/remove', self.path)
        if removal:
            presentations.remove(removal[1])
            return self.reply(200, {'removed': True})
        if self.path == '/api/presentations':
            self.connection.settimeout(180)
            try:
                length = int(self.headers.get('Content-Length', '0'))
                if not 0 < length <= MAX_BYTES:
                    self.close_connection = True
                    return self.reply(413, {'error': 'Choose a non-empty presentation smaller than 100 MB.'})
                if self.headers.get('Content-Type') != 'application/octet-stream':
                    return self.reply(415, {'error': 'Expected a presentation upload.'})
                document = presentations.import_file(self.rfile, length, self.headers.get('X-File-Name', ''))
                try:
                    return self.reply(200, document)
                except (BrokenPipeError, ConnectionResetError):
                    presentations.remove(document['id'])
                    return
            except (BrokenPipeError, ConnectionResetError):
                return
            except (ValueError, subprocess.TimeoutExpired) as error:
                self.close_connection = True
                return self.reply(422, {'error': str(error) if isinstance(error, ValueError) else 'This presentation took too long to open. Try a smaller PDF.'})
            except Exception:
                self.close_connection = True
                return self.reply(500, {'error': 'The presentation could not be prepared. Choose an unlocked PDF file.'})
        if self.path != "/api/export":
            return self.reply(404, {"error": "Not found"})
        if self.headers.get("Content-Type") != "application/octet-stream":
            return self.reply(415, {"error": "Expected a recording upload."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16 * 1024 ** 3:
                return self.reply(413, {"error": "Recording upload exceeds the 16 GB limit or is empty."})
            with tempfile.TemporaryDirectory(prefix="cpe-recording-") as temp:
                folder = Path(temp)
                return self.export_recording(folder, length)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as error:
            self.reply(500, {"error": str(error)})

    def export_recording(self, folder, length):
        header = self.rfile.readline(min(length, 8 * 1024 * 1024))
        if not header.endswith(b"\n"):
            raise ValueError("Missing export metadata.")
        metadata = json.loads(header)
        kind = metadata.get("kind", "all")
        if kind not in ("all", "camera", "screen"):
            raise ValueError("Unknown export format.")
        camera_bytes, screen_bytes = int(metadata["cameraBytes"]), int(metadata["screenBytes"])
        duration_ms = int(metadata["durationMs"])
        camera_offset, screen_offset = int(metadata["cameraOffset"]), int(metadata["screenOffset"])
        needs_camera = kind != "screen"
        needs_screen = kind == "screen" or (kind == "all" and screen_bytes > 0)
        if (camera_bytes < 0 or screen_bytes < 0 or camera_bytes + screen_bytes != length - len(header)
                or needs_camera != (camera_bytes > 0) or needs_screen != (screen_bytes > 0)
                or not 0 <= camera_offset < duration_ms or not 0 <= screen_offset < duration_ms):
            raise ValueError("Invalid recording lengths or offsets.")
        frames = math.ceil(duration_ms * 30 / 1000)
        camera_mp4, slides_mp4 = folder / "camera-mic.mp4", folder / "slides-muted.mp4"
        camera, screen = folder / "camera.webm", folder / "screen.webm"
        if needs_camera:
            save_upload(self.rfile, camera, camera_bytes)
        if needs_screen:
            save_upload(self.rfile, screen, screen_bytes)
        if needs_camera:
            # Review mirrors in CSS. Downloaded camera files carry the mirror effect.
            encode_video(camera, camera_mp4, camera_offset, frames, audio=True, mirror=True)
        if needs_screen:
            encode_video(screen, slides_mp4, screen_offset, frames, audio=False)
        if kind != "all":
            return self.send_file(camera_mp4 if needs_camera else slides_mp4, "video/mp4")
        archive = folder / "recording.zip"
        with zipfile.ZipFile(archive, "w") as package:
            package.write(camera_mp4, camera_mp4.name)
            if needs_screen:
                package.write(slides_mp4, slides_mp4.name)
        self.send_file(archive, "application/zip")

    def send_file(self, path, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        with path.open("rb") as stream:
            shutil.copyfileobj(stream, self.wfile)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--watch-parent", action="store_true")
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    if args.watch_parent:
        def watch_parent():
            sys.stdin.buffer.read()
            server.shutdown()
        threading.Thread(target=watch_parent, daemon=True).start()
    print(f"CPE Studio: http://localhost:{args.port}\nPress Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        presentations.close()
