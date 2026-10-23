import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'

const available = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

// Verify the real encoder contract used by a native producer of cropped BGRA
// frames. The source is synthetic; this test never captures a screen or device.
test('raw recording preserves wall-clock duration, fixed output and audio when stdin ends', {
  skip: !available && 'media encoder unavailable', timeout: 25000,
}, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-media-raw-capture-'))
  const file = join(directory, 'recording.mkv')
  const width = 160, height = 100, fps = 10, count = 30
  // A paced PCM source mirrors a live microphone. Combining lavfi -re with
  // wall-clock timestamps creates a circular pacing reference instead.
  let audioTimer, audioResponse
  const sampleRate = 48000, samples = 960
  const audioChunk = Buffer.alloc(samples * 2)
  for (let index = 0; index < samples; index++) audioChunk.writeInt16LE(Math.round(Math.sin(index / sampleRate * Math.PI * 2 * 450) * 4000), index * 2)
  const server = createServer((_request, response) => {
    audioResponse = response
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' })
    audioTimer = setInterval(() => { if (!response.destroyed) response.write(audioChunk) }, 20)
    response.on('close', () => clearInterval(audioTimer))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const audioUrl = `http://127.0.0.1:${server.address().port}/microphone.pcm`
  const command = [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-nostdin', '-thread_queue_size', '8', '-f', 'rawvideo', '-pixel_format', 'bgra',
    '-video_size', `${width}x${height}`, '-framerate', `${fps}`,
    '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
    '-thread_queue_size', '1024', '-use_wallclock_as_timestamps', '1', '-f', 's16le', '-ar', '48000', '-ac', '1', '-i', audioUrl,
    '-vf', `fps=${fps}`, '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file,
  ]
  const child = spawn('ffmpeg', command, { stdio: ['pipe', 'ignore', 'pipe'] })
  let errors = '', writeError
  child.stderr.setEncoding('utf8').on('data', chunk => { errors = `${errors}${chunk}`.slice(-8000) })
  child.stdin.on('error', error => { writeError = error })
  const completed = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  // Attach a handler immediately so startup failures cannot be unhandled while
  // the simulated recording loop is awaiting its next frame.
  void completed.catch(() => {})
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000)
  const started = performance.now()
  try {
    for (let frame = 0; frame < count; frame++) {
      if (frame === 10) await delay(800)
      const color = frame < 10 ? [0, 0, 255, 255] : [0, 255, 0, 255]
      const pixels = Buffer.alloc(width * height * 4)
      for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(color, offset)
      await new Promise((resolve, reject) => {
        if (writeError) { reject(writeError); return }
        child.stdin.write(pixels, error => error ? reject(error) : resolve())
      })
      await delay(1000 / fps)
    }
    const recordedSeconds = (performance.now() - started) / 1000
    const stopped = performance.now()
    child.stdin.end() // Raw bytes only: no interactive quit or mute command.
    const result = await completed
    assert.equal(result.code, 0, `encoder did not finalize on video EOF: ${errors}`)
    assert.ok(performance.now() - stopped < 3500, `continuous audio delayed stop: ${errors}`)

    const info = JSON.parse(execFileSync('ffprobe', [
      '-v', 'error', '-count_frames', '-show_streams', '-show_format', '-show_packets',
      '-show_entries', 'stream=index,codec_type,width,height,nb_read_frames:format=duration:packet=stream_index,pts_time,duration_time',
      '-of', 'json', file,
    ], { encoding: 'utf8', timeout: 5000, maxBuffer: 4 * 1024 * 1024 }))
    const video = info.streams.find(stream => stream.codec_type === 'video')
    const audio = info.streams.find(stream => stream.codec_type === 'audio')
    assert.ok(video && audio, 'the finalized recording must contain picture and sound')
    assert.deepEqual([video.width, video.height], [width, height])
    assert.ok(Number(video.nb_read_frames) >= count + 4, 'late frame time must be filled, not removed from the recording')
    const duration = Number(info.format.duration)
    assert.ok(duration >= count / fps + 0.4, `the 800 ms pause disappeared: ${duration}s`)
    assert.ok(Math.abs(duration - recordedSeconds) < 0.55, `recorded ${recordedSeconds}s but encoded ${duration}s`)
    const endOf = index => Math.max(...info.packets.filter(packet => packet.stream_index === index)
      .map(packet => Number(packet.pts_time) + Number(packet.duration_time || 0)))
    assert.ok(Math.abs(endOf(video.index) - endOf(audio.index)) < 0.2, `audio/video ends must agree: audio=${endOf(audio.index)} video=${endOf(video.index)}; ${errors}`)

    const pixels = execFileSync('ffmpeg', [
      '-v', 'error', '-i', file, '-map', '0:v:0', '-vsync', '0',
      '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1',
    ], { timeout: 5000, maxBuffer: 16 * 1024 * 1024 })
    const frameBytes = width * height * 3
    assert.equal(pixels.length, Number(video.nb_read_frames) * frameBytes)
    assert.ok(pixels[0] > 240 && pixels[1] < 15, 'the initial frame must decode as red')
    const last = pixels.subarray(pixels.length - frameBytes)
    assert.ok(last[0] < 15 && last[1] > 240, 'the changed capture content must survive finalization')
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await completed.catch(() => {})
    clearInterval(audioTimer)
    audioResponse?.destroy()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  }
})
