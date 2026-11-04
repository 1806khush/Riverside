# CPE Studio

The original HTML/CSS/JavaScript recording prototype, with an updated interface and a Python localhost server for offline Whisper transcription.

## Run from Terminal

```sh
cd ~/Documents/Riverside
python3.12 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py --download-model
python server.py
```

Open http://localhost:8080 in Chrome or Edge. Stop the server with Ctrl+C. Subsequent starts only need `source .venv/bin/activate` and `python server.py`.

On Windows, create the environment with `py -3.12 -m venv .venv` and activate it with `.venv\Scripts\activate`.

Dependencies and the model require a one-time download. Post-recording transcription then runs locally: MLX Whisper on Apple Silicon, Faster Whisper on CPU/CUDA on other computers. Browser recording still requires camera, microphone, and screen permissions. Recording data is buffered in the browser's local IndexedDB for saving, review, and export. Download your files from the review page after stopping the recording; there is no recordings library to browse later.

Use Start recording, Pause/Resume, Stop & save, then Generate transcript. Download everything exports the separate recording tracks and available transcript files. There is no editing workflow in this project.

The packaged desktop app and its build files have been removed. This version has not been launched or tested, as requested.
