/* SPDX-License-Identifier: GPL-3.0-or-later
 * Copyright 2026 Open Media contributors
 * Isolated offline recognition helper, linked to the pinned shared runtime.
 */
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sherpa-onnx/c-api/c-api.h"

static const char *option(int argc, char **argv, const char *name) {
  size_t length = strlen(name);
  for (int i = 1; i < argc; ++i)
    if (!strncmp(argv[i], name, length) && argv[i][length] == '=')
      return argv[i] + length + 1;
  return NULL;
}

static void string_json(const char *value) {
  putchar('"');
  if (value) {
    for (const unsigned char *p = (const unsigned char *)value; *p; ++p) {
      if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
      else if (*p < 32) printf("\\u%04x", *p);
      else putchar(*p);
    }
  }
  putchar('"');
}

static int valid_timing(float start, float duration) {
  return isfinite(start) && isfinite(duration) && start >= 0 && duration >= 0;
}

int main(int argc, char **argv) {
  const char *provider = option(argc, argv, "--provider");
  if (!provider || !strcmp(provider, "auto")) {
#if defined(__APPLE__)
    provider = "coreml";
#else
    provider = "cpu";
#endif
  }
  if (strcmp(provider, "cpu") && strcmp(provider, "coreml") && strcmp(provider, "cuda")) {
    fprintf(stderr, "Unsupported recognition provider.\n"); return 2;
  }
  for (int i = 1; i < argc; ++i) {
    if (!strcmp(argv[i], "--self-test")) {
      printf("{\"ready\":true,\"engineVersion\":"); string_json(SherpaOnnxGetVersionStr());
      printf(",\"preferredProvider\":"); string_json(provider); puts("}"); return 0;
    }
  }
  const char *encoder = option(argc, argv, "--encoder");
  const char *decoder = option(argc, argv, "--decoder");
  const char *tokens = option(argc, argv, "--tokens");
  const char *wave_file = option(argc, argv, "--wave");
  const char *language = option(argc, argv, "--language");
  if (!encoder || !decoder || !tokens || !wave_file) {
    fprintf(stderr, "Recognition requires encoder, decoder, tokens and a wave file.\n"); return 2;
  }
  const SherpaOnnxWave *wave = SherpaOnnxReadWave(wave_file);
  if (!wave || wave->sample_rate != 16000 || wave->num_samples <= 0 || wave->num_samples > 30 * 16000) {
    if (wave) SherpaOnnxFreeWave(wave);
    fprintf(stderr, "Expected at most 30 seconds of mono 16 kHz PCM.\n"); return 2;
  }
  SherpaOnnxOfflineRecognizerConfig config;
  memset(&config, 0, sizeof(config));
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.whisper.encoder = encoder;
  config.model_config.whisper.decoder = decoder;
  config.model_config.whisper.language = language && strcmp(language, "auto") ? language : "";
  config.model_config.whisper.task = "transcribe";
  config.model_config.whisper.tail_paddings = 1000;
  config.model_config.whisper.enable_token_timestamps = 1;
  config.model_config.whisper.enable_segment_timestamps = 1;
  config.model_config.tokens = tokens;
  config.model_config.num_threads = 2;
  config.model_config.provider = provider;
  config.decoding_method = "greedy_search";
  fprintf(stderr, "stage=loading,device=%s\n", provider); fflush(stderr);
  const SherpaOnnxOfflineRecognizer *recognizer = SherpaOnnxCreateOfflineRecognizer(&config);
  if (!recognizer) {
    SherpaOnnxFreeWave(wave);
    fprintf(stderr, "Recognition model could not be loaded.\n"); return 3;
  }
  const SherpaOnnxOfflineStream *stream = SherpaOnnxCreateOfflineStream(recognizer);
  if (!stream) {
    SherpaOnnxFreeWave(wave); SherpaOnnxDestroyOfflineRecognizer(recognizer);
    fprintf(stderr, "Recognition stream could not be created.\n"); return 3;
  }
  SherpaOnnxAcceptWaveformOffline(stream, wave->sample_rate, wave->samples, wave->num_samples);
  const double duration = (double)wave->num_samples / wave->sample_rate;
  SherpaOnnxFreeWave(wave);
  fprintf(stderr, "stage=recognizing,device=%s\n", provider); fflush(stderr);
  SherpaOnnxDecodeOfflineStream(recognizer, stream);
  const SherpaOnnxOfflineRecognizerResult *result = SherpaOnnxGetOfflineStreamResult(stream);
  if (!result || !result->text || result->count < 0 || result->count > 10000 || result->segment_count < 0 || result->segment_count > 2000) {
    if (result) SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream); SherpaOnnxDestroyOfflineRecognizer(recognizer);
    fprintf(stderr, "Recognition returned an invalid result.\n"); return 4;
  }
  const int token_timing = result->timestamps && result->durations && result->tokens_arr;
  const int segment_timing = result->segment_timestamps && result->segment_durations && result->segment_texts_arr;
  if (*result->text && !token_timing && !segment_timing) {
    SherpaOnnxDestroyOfflineRecognizerResult(result);
    SherpaOnnxDestroyOfflineStream(stream); SherpaOnnxDestroyOfflineRecognizer(recognizer);
    fprintf(stderr, "The installed model did not return real timestamps.\n"); return 4;
  }
  printf("{\"text\":"); string_json(result->text);
  printf(",\"language\":"); string_json(result->lang && *result->lang ? result->lang : language);
  printf(",\"backend\":"); string_json(provider);
  printf(",\"duration\":%.8f,\"timestampKind\":\"model\",\"tokens\":[", duration);
  int written = 0;
  if (token_timing) for (int i = 0; i < result->count; ++i) {
    if (!valid_timing(result->timestamps[i], result->durations[i])) continue;
    if (written++) putchar(',');
    printf("{\"text\":"); string_json(result->tokens_arr[i]);
    printf(",\"start\":%.8f,\"end\":%.8f}", result->timestamps[i], result->timestamps[i] + result->durations[i]);
  }
  printf("],\"segments\":["); written = 0;
  if (segment_timing) for (int i = 0; i < result->segment_count; ++i) {
    if (!valid_timing(result->segment_timestamps[i], result->segment_durations[i])) continue;
    if (written++) putchar(',');
    printf("{\"text\":"); string_json(result->segment_texts_arr[i]);
    printf(",\"start\":%.8f,\"end\":%.8f}", result->segment_timestamps[i], result->segment_timestamps[i] + result->segment_durations[i]);
  }
  puts("]}"); fflush(stdout);
  SherpaOnnxDestroyOfflineRecognizerResult(result);
  SherpaOnnxDestroyOfflineStream(stream);
  SherpaOnnxDestroyOfflineRecognizer(recognizer);
  return ferror(stdout) ? 5 : 0;
}
