"""Run the recording project with: python server.py"""
from __future__ import annotations

import argparse
import json
import os
import platform
import math
import shutil
import zipfile
import subprocess
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from enhance import FACE_MODEL, MODELS, download_enhancement_models, magic_audio_filter, require_model

ROOT = Path(__file__).resolve().parent
APPLE = platform.system() == "Darwin" and platform.machine() == "arm64"
MODEL = ROOT / "models" / ("whisper-base-mlx" if APPLE else "whisper-base-ct2")
ASR_LOCK = threading.Lock()
cached_model = None


def download_model():
    from huggingface_hub import snapshot_download
    repo = "mlx-community/whisper-base-mlx" if APPLE else "Systran/faster-whisper-base"
    patterns = ["config.json", "weights.npz", "weights.safetensors"] if APPLE else None
    snapshot_download(repo, local_dir=str(MODEL), allow_patterns=patterns)
    print(f"Local Whisper model saved to {MODEL}")


def transcribe(path):
    global cached_model
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    os.environ.setdefault("NUMBA_CACHE_DIR", str(ROOT / ".cache" / "numba"))
    if not MODEL.is_dir():
        raise RuntimeError("Local model is missing. Run python server.py --download-model first.")
    import imageio_ffmpeg
    import numpy as np
    command = [imageio_ffmpeg.get_ffmpeg_exe(), "-nostdin", "-v", "error", "-i", str(path),
               "-f", "s16le", "-ac", "1", "-ar", "16000", "-"]
    decoded = subprocess.run(command, capture_output=True)
    if decoded.returncode:
        raise RuntimeError("Could not read recording audio: " + decoded.stderr.decode(errors="replace")[-400:])
    samples = np.frombuffer(decoded.stdout, dtype=np.int16).astype(np.float32) / 32768
    if not len(samples):
        raise RuntimeError("No microphone audio was found.")
    if APPLE:
        import mlx.core as mx
        import mlx_whisper
        mx.set_default_device(mx.gpu)
        result = mlx_whisper.transcribe(samples, path_or_hf_repo=str(MODEL),
                                         word_timestamps=True, verbose=None,
                                         condition_on_previous_text=False)
        segments = result.get("segments", [])
        language = result.get("language", "")
    else:
        import ctranslate2
        from faster_whisper import WhisperModel
        if cached_model is None:
            device = "cuda" if ctranslate2.get_cuda_device_count() else "cpu"
            cached_model = WhisperModel(str(MODEL), device=device,
                                       compute_type="float16" if device == "cuda" else "int8",
                                       local_files_only=True)
        output, info = cached_model.transcribe(samples, word_timestamps=True)
        segments = [{"start": s.start, "end": s.end, "text": s.text,
                     "words": [{"start": w.start, "end": w.end, "word": w.word} for w in (s.words or [])]}
                    for s in output]
        language = info.language
    clean = [{"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()}
             for s in segments]
    words = [{"start": float(w["start"]), "end": float(w["end"]), "word": w["word"].strip()}
             for s in segments for w in s.get("words", [])]
    return {"text": " ".join(s["text"] for s in clean), "language": language,
            "segments": clean, "words": words, "model": "whisper-base", "source": "local-whisper"}


def save_upload(source, path, remaining):
    with path.open("wb") as stream:
        while remaining:
            chunk = source.read(min(remaining, 1024 * 1024))
            if not chunk:
                raise ValueError("Upload was interrupted.")
            stream.write(chunk)
            remaining -= len(chunk)


def encode_video(source, target, offset_ms, frames, audio, magic_audio=False, eye_contact=False, mirror=False):
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
    video_input = "0:v:0"
    corrected_frames = None
    if eye_contact:
        corrected = target.with_name("gaze-intermediate.mp4")
        require_model(FACE_MODEL)
        # Isolate native face inference so a worker error leaves the studio running.
        gaze = subprocess.run(
            [sys.executable, str(ROOT / "enhance.py"), str(source), str(corrected), str(frames)],
            capture_output=True,
        )
        if gaze.returncode:
            detail = gaze.stderr.decode(errors="replace").strip().splitlines()
            raise RuntimeError("Eye Contact could not process this video. " + (detail[-1] if detail else ""))
        corrected_frames = int(gaze.stdout.strip())
        if corrected_frames:
            command += ["-i", str(corrected)]
            video_input = "1:v:0"
    command += [
        "-map", video_input, "-vf", video,
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-r", "30", "-fps_mode", "cfr",
    ]
    if audio:
        filters = "aresample=async=1:first_pts=0"
        if magic_audio:
            filters += "," + magic_audio_filter()
        filters += f",adelay={offset_ms}:all=1,apad,atrim=duration={duration:.9f}"
        command += [
            "-map", "0:a:0", "-af",
            filters,
            "-c:a", "aac", "-b:a", "192k",
        ]
    else:
        command += ["-an"]
    command += ["-movflags", "+faststart", str(target)]
    result = subprocess.run(command, capture_output=True, cwd=MODELS if magic_audio else None)
    if result.returncode:
        raise RuntimeError("Could not encode " + target.name + ": " + result.stderr.decode(errors="replace")[-400:])
    return corrected_frames


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = urlsplit(self.path).path
        assets = {
            "/", "/index.html", "/styles.css", "/app.js",
            "/camera-effects.js", "/camera-effects-worker.js", "/effects-panel.js",
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
        super().end_headers()

    def reply(self, status, body):
        payload = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        if self.path not in ("/api/transcribe", "/api/export"):
            return self.reply(404, {"error": "Not found"})
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            return self.reply(403, {"error": "Request must come from this local project."})
        if self.headers.get("Content-Type") != "application/octet-stream":
            return self.reply(415, {"error": "Expected a recording upload."})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 16 * 1024 ** 3:
                return self.reply(413, {"error": "Recording upload exceeds the 16 GB limit or is empty."})
            with tempfile.TemporaryDirectory(prefix="cpe-recording-") as temp:
                folder = Path(temp)
                if self.path == "/api/export":
                    return self.export_recording(folder, length)
                camera = folder / "camera.webm"
                save_upload(self.rfile, camera, length)
                with ASR_LOCK:
                    result = transcribe(camera)
            self.reply(200, result)
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
        magic_audio = needs_camera and metadata.get("magicAudio") is True
        eye_contact = needs_camera and metadata.get("eyeContact") is True
        review = kind == "camera" and metadata.get("review") is True
        if review:
            frames = math.ceil((duration_ms - camera_offset) * 30 / 1000)
            camera_offset = 0
        camera_mp4, slides_mp4 = folder / "camera-mic.mp4", folder / "slides-muted.mp4"
        camera, screen = folder / "camera.webm", folder / "screen.webm"
        if needs_camera:
            save_upload(self.rfile, camera, camera_bytes)
        if needs_screen:
            save_upload(self.rfile, screen, screen_bytes)
        corrected_frames = None
        if needs_camera:
            # Review mirrors in CSS. Downloaded camera files carry the mirror effect.
            corrected_frames = encode_video(camera, camera_mp4, camera_offset, frames, audio=True,
                         magic_audio=magic_audio, eye_contact=eye_contact, mirror=not review)
        if needs_screen:
            encode_video(screen, slides_mp4, screen_offset, frames, audio=False)
        if kind != "all":
            return self.send_file(camera_mp4 if needs_camera else slides_mp4, "video/mp4", corrected_frames, review)
        archive = folder / "recording.zip"
        with zipfile.ZipFile(archive, "w") as package:
            package.write(camera_mp4, camera_mp4.name)
            if needs_screen:
                package.write(slides_mp4, slides_mp4.name)
            package.writestr("transcript.txt", metadata["transcript"].strip() + "\n")
        self.send_file(archive, "application/zip")

    def send_file(self, path, content_type, corrected_frames=None, review=False):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if review:
            self.send_header("X-CPE-Review", "1")
        if corrected_frames is not None:
            self.send_header("X-CPE-Corrected-Frames", str(corrected_frames))
        self.send_header("Content-Length", str(path.stat().st_size))
        self.end_headers()
        with path.open("rb") as stream:
            shutil.copyfileobj(stream, self.wfile)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--download-model", action="store_true")
    parser.add_argument("--download-enhancement-models", action="store_true")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()
    if args.download_model:
        download_model()
    elif args.download_enhancement_models:
        download_enhancement_models()
    else:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
        print(f"CPE Studio: http://localhost:{args.port}\nPress Ctrl+C to stop.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            server.server_close()
