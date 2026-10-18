import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyHardwareEncoderInventory, verifyHardwareProbeOutput } from '../scripts/media-runtime-capabilities.mjs';

test('a CPU-only encoder list cannot pass a desktop GPU-capable build gate', () => {
  const cpu = ' V....D libx264 H.264 encoder\n';
  assert.throws(() => verifyHardwareEncoderInventory('darwin', cpu), /h264_videotoolbox/);
  assert.throws(() => verifyHardwareEncoderInventory('win32', cpu), /h264_nvenc/);
  assert.throws(() => verifyHardwareEncoderInventory('win32', cpu + ' V....D h264_nvenc NVIDIA encoder\n'), /h264_amf/);
  assert.throws(() => verifyHardwareEncoderInventory('darwin', ' h264_videotoolbox_fake '), /Missing/);
  assert.deepEqual(verifyHardwareEncoderInventory('linux', cpu), []);
});

test('platform inventories declare only hardware codecs actually compiled for that platform', () => {
  const output = ' V....D h264_videotoolbox VideoToolbox\n V....D h264_nvenc NVIDIA\n V....D h264_amf AMD\n';
  assert.deepEqual(verifyHardwareEncoderInventory('darwin', output), ['h264_videotoolbox']);
  assert.deepEqual(verifyHardwareEncoderInventory('win32', output), ['h264_nvenc', 'h264_amf']);
});

test('a successful process must still produce three valid video frames', () => {
  const stream = { codec_name: 'h264', width: 128, height: 72, nb_read_frames: '3' };
  verifyHardwareProbeOutput({ streams: [stream] });
  for (const value of [{}, { streams: [] }, { streams: [stream, stream] },
    ...[{ nb_read_frames: '0' }, { nb_read_frames: 'N/A' }, { width: 64 }, { height: 64 }, { codec_name: 'png' }]
      .map(change => ({ streams: [{ ...stream, ...change }] }))]) {
    assert.throws(() => verifyHardwareProbeOutput(value), /output is invalid/);
  }
});
