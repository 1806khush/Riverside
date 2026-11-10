"""Local PDF preview rendering. No desktop capture or document conversion."""
from __future__ import annotations

import atexit
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from urllib.parse import unquote

MAX_BYTES = 100 * 1024 * 1024
MAX_PAGES = 300


def run_worker(folder, page=None, thumbnail=False):
    mode = '--inspect' if page is None else '--thumbnail' if thumbnail else '--render'
    command = [sys.executable, str(Path(__file__).resolve()), mode, str(folder)]
    if page is not None:
        command.append(str(page))
    result = subprocess.run(command, capture_output=True, timeout=45)
    if result.returncode:
        try:
            message = json.loads(result.stdout).get('error')
        except (ValueError, AttributeError):
            message = None
        raise ValueError(message or 'This PDF could not be opened. Choose an unlocked PDF.')
    return json.loads(result.stdout) if page is None else folder / f'{"thumb-" if thumbnail else ""}{page}.png'


class PresentationStore:
    def __init__(self):
        self.temp = None
        self.documents = {}
        self.lock = threading.RLock()
        self.import_lock = threading.Lock()
        atexit.register(self.close)

    def import_file(self, source, length, filename):
        if not self.import_lock.acquire(blocking=False):
            raise ValueError('Another presentation is being prepared. Please wait.')
        folder = None
        try:
            name = Path(unquote(filename).replace('\\', '/')).name
            suffix = Path(name).suffix.lower()
            if suffix != '.pdf':
                raise ValueError('Choose a PDF file. PowerPoint uploads are not supported in this desktop version.')
            if not 0 < length <= MAX_BYTES:
                raise ValueError('Choose a non-empty presentation smaller than 100 MB.')
            with self.lock:
                if len(self.documents) >= 8:
                    raise ValueError('Stop sharing unused presentations before uploading another.')
                if self.temp is None:
                    self.temp = tempfile.TemporaryDirectory(prefix='cpe-presentations-')
                identifier = uuid.uuid4().hex
                folder = Path(self.temp.name) / identifier
                folder.mkdir(mode=0o700)
            uploaded = folder / ('slides' + suffix)
            with uploaded.open('wb') as target:
                remaining = length
                while remaining:
                    chunk = source.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise ValueError('The presentation upload was interrupted.')
                    target.write(chunk)
                    remaining -= len(chunk)
            signature = uploaded.open('rb')
            with signature:
                magic = signature.read(8)
            if suffix == '.pdf' and not magic.startswith(b'%PDF-'):
                raise ValueError('This file is not a valid PDF.')
            details = run_worker(folder)
            document = {'id': identifier, 'name': name[:240], 'pages': details['pages'], 'format': suffix[1:]}
            with self.lock:
                self.documents[identifier] = document
            return document
        except Exception:
            if folder:
                shutil.rmtree(folder, ignore_errors=True)
            raise
        finally:
            self.import_lock.release()

    def page(self, identifier, number, thumbnail=False):
        # Serialize native workers and removal so a page cannot disappear while being sent.
        with self.lock:
            document = self.documents.get(identifier)
            if not document or not 1 <= number <= document['pages']:
                raise KeyError('Presentation page not found.')
            folder = Path(self.temp.name) / identifier
            target = folder / f'{"thumb-" if thumbnail else ""}{number}.png'
            if not target.is_file():
                run_worker(folder, number, thumbnail)
            payload = target.read_bytes()
            # Bound cached image files even for long lecture decks.
            pages = sorted(folder.glob('[0-9]*.png'), key=lambda item: item.stat().st_mtime)
            for stale in pages[:-8]:
                if stale != target:
                    stale.unlink(missing_ok=True)
            return payload

    def remove(self, identifier):
        with self.lock:
            if self.documents.pop(identifier, None):
                shutil.rmtree(Path(self.temp.name) / identifier, ignore_errors=True)

    def close(self):
        with self.lock:
            if self.temp:
                self.temp.cleanup()
                self.temp = None
            self.documents.clear()


def pdf_worker(mode, folder, number=None):
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(folder / 'slides.pdf') as document:
        count = len(document)
        if not 1 <= count <= MAX_PAGES:
            raise ValueError(f'Presentations must have between 1 and {MAX_PAGES} pages.')
        if mode == '--inspect':
            print(json.dumps({'pages': count}))
            return
        if not 1 <= number <= count:
            raise ValueError('Page out of range.')
        page = document[number - 1]
        try:
            width, height = page.get_size()
            if not all(math.isfinite(value) and value > 0 for value in (width, height)):
                raise ValueError('Invalid page size.')
            max_width, max_height = (240, 135) if mode == '--thumbnail' else (1920, 1080)
            scale = min(max_width / width, max_height / height)
            bitmap = page.render(scale=scale)
            try:
                image = bitmap.to_pil()
                try:
                    image.save(folder / f'{"thumb-" if mode == "--thumbnail" else ""}{number}.png', format='PNG')
                finally:
                    image.close()
            finally:
                bitmap.close()
        finally:
            page.close()


store = PresentationStore() if __name__ != '__main__' else None

if __name__ == '__main__':
    try:
        pdf_worker(sys.argv[1], Path(sys.argv[2]), int(sys.argv[3]) if len(sys.argv) > 3 else None)
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else 'This PDF could not be opened. Choose an unlocked PDF.'
        print(json.dumps({'error': message}))
        sys.exit(1)
