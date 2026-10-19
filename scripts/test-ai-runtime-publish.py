#!/usr/bin/env python3
"""Check split component archive verification without downloading packages."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

SPEC = importlib.util.spec_from_file_location('publish', Path(__file__).with_name('ai-runtime-publish.py'))
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class SplitArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.files = {'python/bin/python3': b'interpreter', 'runner/check.py': b'print(1)'}
        self.manifest = json.dumps({'schema': 1, 'files': [dict(path=name, size=len(data),
            sha256=hashlib.sha256(data).hexdigest()) for name, data in self.files.items()]}).encode()
        self.item = dict(executable='python/bin/python3', script='runner/check.py',
                         manifestSha256=hashlib.sha256(self.manifest).hexdigest())

    def tearDown(self):
        self.tmp.cleanup()

    def archive(self, extra=None, manifest=None):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            archive.writestr('manifest.json', manifest if manifest is not None else self.manifest)
            for name, data in {**self.files, **(extra or {})}.items():
                archive.writestr(name, data)
        return buffer.getvalue()

    def split(self, data):
        paths = []
        for index, chunk in enumerate((data[:71], data[71:221], data[221:])):
            path = self.root / str(index)
            path.write_bytes(chunk)
            paths.append(path)
        return paths

    def test_reads_and_seeks_across_parts(self):
        data = self.archive()
        with MODULE.JoinedArchive(self.split(data)) as stream:
            self.assertEqual(stream.read(), data)
            stream.seek(65)
            self.assertEqual(stream.read(160), data[65:225])
            stream.seek(-21, 2)
            self.assertEqual(stream.read(100), data[-21:])
            self.assertEqual(stream.read(1), b'')
            stream.seek(0)
            stream.seek(17, 1)
            self.assertEqual(stream.read(15), data[17:32])

    def test_accepts_locked_manifest_across_three_parts(self):
        MODULE.validate_manifest(self.split(self.archive()), self.item)

    def test_rejects_changed_manifest(self):
        with self.assertRaisesRegex(ValueError, 'differs from'):
            MODULE.validate_manifest(self.split(self.archive()), {**self.item, 'manifestSha256': '0' * 64})

    def test_rejects_unlisted_payload(self):
        with self.assertRaisesRegex(ValueError, 'file lists differ'):
            MODULE.validate_manifest(self.split(self.archive({'extra.py': b'extra'})), self.item)

    def test_rejects_missing_runtime_entry(self):
        with self.assertRaisesRegex(ValueError, 'entry point'):
            MODULE.validate_manifest(self.split(self.archive()), {**self.item, 'script': 'runner/missing.py'})

    def test_rejects_mismatched_file_size(self):
        with self.assertRaisesRegex(ValueError, 'inconsistent'):
            MODULE.validate_manifest(self.split(self.archive({'runner/check.py': b'changed file'})), self.item)


if __name__ == '__main__':
    unittest.main()
