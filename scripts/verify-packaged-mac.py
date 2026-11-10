"""Verify the final read-only DMG without the development runtime or models."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / 'package.json').read_text())['version']
image = root / f'dist/CPE-Studio-{version}-mac-arm64.dmg'
mount = Path(tempfile.mkdtemp(prefix='cpe-dmg-check-'))
moved = []
mounted = False
try:
    subprocess.run(['hdiutil', 'attach', '-readonly', '-nobrowse', '-mountpoint', str(mount), str(image)], check=True)
    mounted = True
    for source in [root / '.build/runtime', root / 'models']:
        target = source.with_name(source.name + '-verification-backup')
        if target.exists():
            raise RuntimeError(f'Resolve the existing backup first: {target}')
        source.rename(target)
        moved.append((source, target))
    bundle = mount / 'CPE Studio.app'
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(bundle)], check=True)
    env = {**os.environ, 'PATH': '/usr/bin:/bin', 'PYTHONNOUSERSITE': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    for key in ['PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV']:
        env.pop(key, None)
    subprocess.run([str(bundle / 'Contents/MacOS/CPE Studio'), '--smoke-test'], cwd=mount, env=env, check=True, timeout=150)
    resources = bundle / 'Contents/Resources'
    manifest = json.loads((resources / 'runtime/runtime.json').read_text())
    python = resources / 'runtime' / manifest['python']
    subprocess.run([str(python), str(root / 'scripts/verify-backend.py'), str(resources / 'studio')],
                   cwd=mount, env=env, check=True, timeout=180)
    print('PACKAGED_DMG_PASSED: read-only volume; development runtime/models unavailable; PATH excludes Homebrew')
finally:
    for source, target in reversed(moved):
        target.rename(source)
    if mounted:
        subprocess.run(['hdiutil', 'detach', str(mount)], check=True)
    mount.rmdir()
