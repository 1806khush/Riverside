"""Local, optional camera-track enhancements."""
from pathlib import Path
from urllib.request import urlopen
import shutil

MODELS = Path(__file__).resolve().parent / "models"
NOISE_MODEL = MODELS / "std.rnnn"
FACE_MODEL = MODELS / "face_landmarker.task"
MODEL_URLS = {
    MODELS / "selfie_multiclass_256x256.tflite": "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
    NOISE_MODEL: "https://raw.githubusercontent.com/richardpl/arnndn-models/master/std.rnnn",
    FACE_MODEL: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
}


def download_enhancement_models():
    MODELS.mkdir(exist_ok=True)
    for path, url in MODEL_URLS.items():
        if path.is_file():
            continue
        temp = path.with_suffix(".partial")
        try:
            with urlopen(url, timeout=60) as response, temp.open("wb") as output:
                shutil.copyfileobj(response, output)
            temp.replace(path)
        finally:
            temp.unlink(missing_ok=True)
        print(f"Downloaded {path.name}")


def require_model(path):
    if not path.is_file():
        raise RuntimeError("Run python server.py --download-enhancement-models first.")


def magic_audio_filter():
    require_model(NOISE_MODEL)
    # FFmpeg reads the model from the encoder's working directory.
    # The bundled filter has one 480-sample block of latency at 48 kHz.
    # Feed two extra blocks so the final speech samples survive delay removal.
    return "aresample=48000,apad=pad_len=960,arnndn=m=std.rnnn:mix=0.75,atrim=start_sample=480,asetpts=N/SR/TB"


# Eye corners, upper lid, lower lid, and iris center from the Face Landmarker mesh.
EYES = ((33, 133, 159, 145, 468), (362, 263, 386, 374, 473))


def eye_geometry(points, indices):
    import numpy as np

    left, right, upper, lower, iris = points[list(indices)]
    axis = right - left
    width = np.linalg.norm(axis)
    if width < 22:
        return None
    axis /= width
    normal = np.array([-axis[1], axis[0]])
    opening = np.dot(lower - upper, normal)
    if opening < max(5, width * 0.12):
        return None
    center = (upper + lower) / 2
    error = iris - center
    horizontal, vertical = np.dot(error, axis), np.dot(error, normal)
    if abs(horizontal) > width * 0.20 or abs(vertical) > opening * 0.42:
        return None
    correction = np.clip(-horizontal * 0.70, -width * 0.07, width * 0.07) * axis
    correction += np.clip(-vertical * 0.50, -opening * 0.16, opening * 0.16) * normal
    return center, axis, normal, width, opening, correction


def warp_eye(frame, geometry, correction):
    import numpy as np

    center, axis, normal, width, opening, _ = geometry
    height, frame_width = frame.shape[:2]
    radius = int(width / 2) + 2
    cx, cy = center
    x0, x1 = max(0, int(cx) - radius), min(frame_width, int(cx) + radius + 1)
    y0, y1 = max(0, int(cy) - radius), min(height, int(cy) + radius + 1)
    if x0 >= x1 or y0 >= y1:
        return
    y, x = np.mgrid[y0:y1, x0:x1]
    u = ((x - cx) * axis[0] + (y - cy) * axis[1]) / (width * 0.38)
    v = ((x - cx) * normal[0] + (y - cy) * normal[1]) / (opening * 0.44)
    # Taper displacement to zero at the lid and corners.
    weight = np.clip(1 - u * u - v * v, 0, 1) ** 2
    sx = np.clip(x - correction[0] * weight, 0, frame_width - 1)
    sy = np.clip(y - correction[1] * weight, 0, height - 1)
    ix, iy = sx.astype(int), sy.astype(int)
    dx, dy = (sx - ix)[..., None], (sy - iy)[..., None]
    nx, ny = np.minimum(ix + 1, frame_width - 1), np.minimum(iy + 1, height - 1)
    top = frame[iy, ix] * (1 - dx) + frame[iy, nx] * dx
    bottom = frame[ny, ix] * (1 - dx) + frame[ny, nx] * dx
    frame[y0:y1, x0:x1] = np.rint(top * (1 - dy) + bottom * dy).astype(np.uint8)


def correct_gaze(source, output, max_frames):
    require_model(FACE_MODEL)
    try:
        import mediapipe as mp
    except ImportError as error:
        raise RuntimeError("Install Eye Contact dependencies with pip install -r requirements.txt.") from error
    import imageio_ffmpeg
    import numpy as np
    from itertools import islice

    vision = mp.tasks.vision
    options = vision.FaceLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(
            model_asset_path=str(FACE_MODEL), delegate=mp.tasks.BaseOptions.Delegate.CPU
        ),
        running_mode=vision.RunningMode.VIDEO,
        num_faces=1,
        output_facial_transformation_matrixes=True,
    )
    frames = imageio_ffmpeg.read_frames(str(source), output_params=["-vf", "fps=30"])
    writer = None
    previous = None
    corrected_frames = 0
    try:
        width, height = next(frames)["size"]
        writer = imageio_ffmpeg.write_frames(
            str(output), (width, height), fps=30, codec="libx264",
            pix_fmt_in="rgb24", pix_fmt_out="yuv420p", macro_block_size=1,
            output_params=["-preset", "fast", "-crf", "12"],
        )
        writer.send(None)
        with vision.FaceLandmarker.create_from_options(options) as landmarker:
            for index, raw in enumerate(islice(frames, max_frames)):
                frame = np.frombuffer(raw, dtype=np.uint8).reshape(height, width, 3).copy()
                result = landmarker.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=frame), index * 1000 // 30
                )
                eyes = None
                if result.face_landmarks and result.facial_transformation_matrixes:
                    matrix = result.facial_transformation_matrixes[0]
                    # Limit correction to nearly front-facing head poses.
                    forward = matrix[:3, 2]
                    if forward[2] > 0.93 * np.linalg.norm(forward):
                        landmarks = result.face_landmarks[0]
                        if len(landmarks) >= 478:
                            points = np.array([(p.x * width, p.y * height) for p in landmarks])
                            eyes = [eye_geometry(points, eye) for eye in EYES]
                if eyes and all(eye is not None for eye in eyes):
                    shifts = np.array([eye[-1] for eye in eyes])
                    if previous is not None:
                        shifts = 0.55 * previous + 0.45 * shifts
                    if np.max(np.linalg.norm(shifts, axis=1)) >= 0.15:
                        for eye, shift in zip(eyes, shifts):
                            warp_eye(frame, eye, shift)
                        corrected_frames += 1
                    previous = shifts
                else:
                    previous = None
                writer.send(frame.tobytes())
    finally:
        if writer is not None:
            writer.close()
        frames.close()
    return corrected_frames

if __name__ == "__main__":
    import sys
    print(correct_gaze(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])))
