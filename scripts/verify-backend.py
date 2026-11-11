"""Verify private HTTP access and local media export.

Usage: npm run test:media
Uses generated media only; no camera, microphone, speech service, or model download.
"""
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import urllib.request
import urllib.error
import zipfile

studio = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(studio))
import server
import imageio_ffmpeg

with tempfile.TemporaryDirectory(prefix="cpe-backend-check-") as temp:
    folder = Path(temp)
    camera = folder / 'camera.webm'
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=navy:s=320x180:r=30',
                    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
                    '-c:v', 'libvpx', '-c:a', 'libopus', str(camera)], check=True)
    os.environ['CPE_MEDIA_TOKEN'] = 'synthetic-test-token'
    httpd = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    origin = f'http://127.0.0.1:{httpd.server_port}'

    def request(route, data=None, auth=True, **headers):
        if auth:
            headers['Authorization'] = 'Bearer synthetic-test-token'
        return urllib.request.urlopen(urllib.request.Request(origin + route, data=data, headers=headers), timeout=120)

    def rejects(route, status, **kwargs):
        try:
            request(route, **kwargs)
        except urllib.error.HTTPError as error:
            assert error.code == status, (error.code, status)
        else:
            raise AssertionError('Request unexpectedly accepted')

    def export(kind, screen=False, **options):
        camera_data = b'' if kind == 'screen' else camera.read_bytes()
        screen_data = camera.read_bytes() if screen else b''
        metadata = dict(kind=kind, cameraBytes=len(camera_data), screenBytes=len(screen_data),
                        durationMs=2000, cameraOffset=0, screenOffset=0, **options)
        body = json.dumps(metadata).encode() + b'\n' + camera_data + screen_data
        with request('/api/export', data=body, Origin=origin, **{'Content-Type': 'application/octet-stream'}) as response:
            return response.read()

    try:
        rejects('/', 403, auth=False)
        rejects('/', 403, Host='attacker.example')
        rejects('/', 404)
        rejects('/server.py', 404)
        rejects('/api/transcribe', 404, data=b'test', **{'Content-Type': 'application/octet-stream'})
        rejects('/api/export', 403, data=b'test', Origin='https://attacker.example', **{'Content-Type': 'application/octet-stream'})
        with zipfile.ZipFile(io.BytesIO(export('all'))) as archive:
            assert set(archive.namelist()) == {'camera-mic.mp4'}, archive.namelist()
            output = folder / 'camera.mp4'
            output.write_bytes(archive.read('camera-mic.mp4'))
        subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-i', str(output), '-f', 'null', '-'], check=True)
        with zipfile.ZipFile(io.BytesIO(export('all', screen=True))) as archive:
            assert set(archive.namelist()) == {'camera-mic.mp4', 'slides-muted.mp4'}, archive.namelist()
        slides = folder / 'slides.mp4'
        slides.write_bytes(export('screen', screen=True))
        subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-i', str(slides), '-f', 'null', '-'], check=True)
        # A camera-only label / teleprompter must not be burned into camera exports.
        pixels = subprocess.run([ffmpeg, '-nostdin', '-v', 'error', '-i', str(output), '-frames:v', '1',
                                 '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
        assert len(pixels) == 320 * 180 * 3
        assert max(pixels[0::3]) < 20 and max(pixels[1::3]) < 20, 'Unexpected graphic in camera output'
        print('BACKEND_CHECK_PASSED: MP4/ZIP, muted slides, preview-only graphics, removed transcript API')
    finally:
        httpd.shutdown()
        httpd.server_close()
