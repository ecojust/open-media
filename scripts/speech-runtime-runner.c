/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright 2026 Open Media contributors
 * Independent offline speech process. See licenses/speech-runtime/README.md.
 */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "sherpa-onnx/c-api/c-api.h"

static const char *option(int argc, char **argv, const char *name) {
  size_t n = strlen(name);
  for (int i = 1; i < argc; ++i)
    if (!strncmp(argv[i], name, n) && argv[i][n] == '=') return argv[i] + n + 1;
  return NULL;
}

static int32_t progress(const float *samples, int32_t count, float value, void *arg) {
  (void)samples; (void)arg;
  printf("sample=%d, progress=%.6f\n", count, value);
  fflush(stdout);
  return 1;
}

static char *read_text(const char *path) {
  if (!path) return NULL;
  FILE *file = fopen(path, "rb");
  if (!file) return NULL;
  if (fseek(file, 0, SEEK_END)) { fclose(file); return NULL; }
  long length = ftell(file);
  if (length <= 0 || length > 1024 * 1024 || fseek(file, 0, SEEK_SET)) {
    fclose(file); return NULL;
  }
  char *text = (char *)calloc((size_t)length + 1, 1);
  if (!text || fread(text, 1, (size_t)length, file) != (size_t)length) {
    free(text); fclose(file); return NULL;
  }
  fclose(file);
  if (memchr(text, 0, (size_t)length)) { free(text); return NULL; }
  return text;
}

int main(int argc, char **argv) {
  SherpaOnnxOfflineTtsConfig cfg = {0};
  SherpaOnnxGenerationConfig generation = {0};
  cfg.model.kokoro.model = option(argc, argv, "--kokoro-model");
  cfg.model.kokoro.voices = option(argc, argv, "--kokoro-voices");
  cfg.model.kokoro.tokens = option(argc, argv, "--kokoro-tokens");
  cfg.model.kokoro.data_dir = option(argc, argv, "--kokoro-data-dir");
  cfg.model.kokoro.lexicon = option(argc, argv, "--kokoro-lexicon");
  cfg.model.kokoro.length_scale = 1.0f;
  cfg.model.num_threads = 2;
  cfg.model.provider = "cpu";
  cfg.max_num_sentences = 1;
  cfg.silence_scale = 0.2f;
  cfg.rule_fsts = option(argc, argv, "--tts-rule-fsts");
  const char *output = option(argc, argv, "--output-filename");
  const char *speaker = option(argc, argv, "--sid");
  const char *speed = option(argc, argv, "--speed");
  const char *debug = option(argc, argv, "--debug");
  cfg.model.debug = debug && !strcmp(debug, "true");
  generation.sid = speaker ? atoi(speaker) : 3;
  generation.speed = speed ? (float)atof(speed) : 1.0f;
  generation.silence_scale = 0.2f;
  if (!output || !cfg.model.kokoro.model || !cfg.model.kokoro.voices ||
      !cfg.model.kokoro.tokens || !cfg.model.kokoro.data_dir ||
      !cfg.model.kokoro.lexicon || !cfg.rule_fsts ||
      !isfinite(generation.speed) || generation.speed < 0.5f || generation.speed > 2.0f) {
    fprintf(stderr, "Invalid speech configuration.\n"); return 2;
  }
  char *text = read_text(option(argc, argv, "--text-file"));
  if (!text) { fprintf(stderr, "Cannot read UTF-8 speech text file.\n"); return 2; }
  puts("stage=loading"); fflush(stdout);
  const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&cfg);
  if (!tts) { free(text); fprintf(stderr, "Cannot load bundled speech model.\n"); return 3; }
  int32_t speakers = SherpaOnnxOfflineTtsNumSpeakers(tts);
  if (generation.sid < 0 || generation.sid >= speakers) {
    free(text); SherpaOnnxDestroyOfflineTts(tts);
    fprintf(stderr, "Unknown voice.\n"); return 2;
  }
  printf("stage=generating, speakers=%d, text_bytes=%zu\n", speakers, strlen(text));
  fflush(stdout);
  const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
      tts, text, &generation, progress, NULL);
  free(text);
  int ok = audio && audio->n > 0 && audio->sample_rate == 24000 &&
      SherpaOnnxWriteWave(audio->samples, audio->n, audio->sample_rate, output);
  if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  SherpaOnnxDestroyOfflineTts(tts);
  if (!ok) { fprintf(stderr, "Speech generation produced no valid audio.\n"); return 4; }
  puts("stage=complete"); fflush(stdout);
  return 0;
}
