// A compiled encoder and successful hardware execution are distinct evidence.
export function requiredHardwareEncoders(platform) {
  if (platform === 'darwin') return ['h264_videotoolbox'];
  if (platform === 'win32') return ['h264_nvenc', 'h264_amf'];
  return [];
}

export function verifyHardwareEncoderInventory(platform, output) {
  const required = requiredHardwareEncoders(platform);
  for (const encoder of required) {
    if (!new RegExp(`\\s${encoder}\\s`).test(output)) throw new Error(`Missing required hardware encoder: ${encoder}`);
  }
  return required;
}

export function verifyHardwareProbeOutput(info) {
  const streams = info?.streams;
  if (!Array.isArray(streams) || streams.length !== 1 || streams[0].codec_name !== 'h264'
      || streams[0].width !== 128 || streams[0].height !== 72 || streams[0].nb_read_frames !== '3') {
    throw new Error('Hardware encoder returned success but its three-frame output is invalid.');
  }
}
