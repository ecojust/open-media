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
#if defined(OPEN_MEDIA_ORT_PROVIDER_QUERY)
/* GPU component builds supply these headers from the pinned runtime source. */
#include "onnxruntime_c_api.h"
#endif

static int has_flag(int argc, char **argv, const char *flag) {
  for (int i = 1; i < argc; ++i)
    if (!strcmp(argv[i], flag)) return 1;
  return 0;
}

static int has_provider(const char *name) {
#if defined(OPEN_MEDIA_ORT_PROVIDER_QUERY)
  const OrtApi *api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
  if (!api) return 0;
  char **providers = NULL;
  int count = 0;
  OrtStatus *status = api->GetAvailableProviders(&providers, &count);
  if (status) {
    fprintf(stderr, "Cannot inspect execution providers: %s\n", api->GetErrorMessage(status));
    api->ReleaseStatus(status);
    return 0;
  }
  int found = 0;
  for (int i = 0; i < count; ++i)
    if (!strcmp(providers[i], name)) found = 1;
  status = api->ReleaseAvailableProviders(providers, count);
  if (status) api->ReleaseStatus(status);
  return found;
#else
  /* The existing immutable packages have audited build capabilities. Never
   * advertise CUDA merely because an option or a driver exists on the host. */
#if defined(__APPLE__)
  return !strcmp(name, "CPUExecutionProvider") || !strcmp(name, "CoreMLExecutionProvider");
#else
  return !strcmp(name, "CPUExecutionProvider");
#endif
#endif
}

static const char *select_provider(const char *requested) {
  if (requested && !strcmp(requested, "cpu")) return "cpu";
  if (requested && strcmp(requested, "auto")) {
    const char *name = !strcmp(requested, "cuda") ? "CUDAExecutionProvider" : "CoreMLExecutionProvider";
    if (has_provider(name)) return requested;
    printf("stage=fallback,from=%s,device=cpu,reason=runtime_provider_unavailable\n", requested);
    return "cpu";
  }
#if defined(__APPLE__)
  if (has_provider("CoreMLExecutionProvider")) return "coreml";
#endif
  if (has_provider("CUDAExecutionProvider")) return "cuda";
  return "cpu";
}

static int test_cuda_provider_load(void) {
#if defined(OPEN_MEDIA_ORT_PROVIDER_QUERY)
  const OrtApi *api = OrtGetApiBase()->GetApi(ORT_API_VERSION);
  OrtEnv *env = NULL;
  OrtSessionOptions *session = NULL;
  OrtCUDAProviderOptionsV2 *cuda = NULL;
  if (!api || !has_provider("CUDAExecutionProvider")) {
    fprintf(stderr, "CUDA provider is absent from this runtime.\n");
    return 3;
  }
  /* The official loader installs ProviderHost before loading provider DLLs.
   * Direct LoadLibrary bypasses that required initialization and is invalid.
   * Registering the factory checks loading, not GPU execution or availability. */
  OrtStatus *status = api->CreateEnv(ORT_LOGGING_LEVEL_WARNING, "speech-provider-check", &env);
  if (!status) status = api->CreateSessionOptions(&session);
  if (!status) status = api->CreateCUDAProviderOptions(&cuda);
  if (!status) status = api->SessionOptionsAppendExecutionProvider_CUDA_V2(session, cuda);
  int failed = status != NULL;
  if (status) {
    fprintf(stderr, "CUDA provider initialization failed: %s\n", api->GetErrorMessage(status));
    api->ReleaseStatus(status);
  }
  if (session) api->ReleaseSessionOptions(session);
  if (cuda) api->ReleaseCUDAProviderOptions(cuda);
  if (env) api->ReleaseEnv(env);
  if (failed) return 3;
  printf("{\"provider\":\"cuda\",\"providerLoadVerified\":true,\"gpuInferenceVerified\":false,"
         "\"selfTest\":\"official-provider-registration\"}\n");
  return 0;
#else
  fprintf(stderr, "Provider registration checks require the optional GPU runtime.\n");
  return 3;
#endif
}

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

static int valid_audio(const SherpaOnnxGeneratedAudio *audio, int sample_rate) {
  if (!audio || !audio->samples || audio->n <= 0 || audio->sample_rate != sample_rate)
    return 0;
  double squared_sum = 0.0;
  for (int32_t i = 0; i < audio->n; ++i) {
    double sample = audio->samples[i];
    if (!isfinite(sample)) return 0;
    squared_sum += sample * sample;
  }
  /* Validate before PCM conversion can hide invalid or silent GPU output. */
  return squared_sum / audio->n >= 1e-10;
}

int main(int argc, char **argv) {
  SherpaOnnxOfflineTtsConfig cfg = {0};
  SherpaOnnxGenerationConfig generation = {0};
  const char *matcha_model = option(argc, argv, "--matcha-acoustic-model");
  const char *kokoro_model = option(argc, argv, "--kokoro-model");
  const char *zipvoice_encoder = option(argc, argv, "--zipvoice-encoder");
  const char *requested_provider = option(argc, argv, "--provider");
  if (requested_provider && strcmp(requested_provider, "auto") &&
      strcmp(requested_provider, "cpu") && strcmp(requested_provider, "coreml") &&
      strcmp(requested_provider, "cuda")) {
    fprintf(stderr, "Unsupported speech execution provider.\n"); return 2;
  }
  if (has_flag(argc, argv, "--self-test-provider-load")) return test_cuda_provider_load();
  if (has_flag(argc, argv, "--self-test")) {
    const char *provider = select_provider(requested_provider);
    printf("stage=device,device=%s,engine=native\n", provider);
    printf("{\"provider\":\"%s\",\"gpuInferenceVerified\":false,\"selfTest\":\"runtime-load-and-capabilities\"}\n", provider);
    return 0;
  }
  if ((!!matcha_model + !!kokoro_model + !!zipvoice_encoder) != 1) {
    fprintf(stderr, "Select exactly one speech model.\n"); return 2;
  }
  cfg.model.matcha.acoustic_model = matcha_model;
  cfg.model.matcha.vocoder = option(argc, argv, "--matcha-vocoder");
  cfg.model.matcha.tokens = option(argc, argv, "--matcha-tokens");
  cfg.model.matcha.data_dir = option(argc, argv, "--matcha-data-dir");
  cfg.model.matcha.lexicon = option(argc, argv, "--matcha-lexicon");
  cfg.model.matcha.noise_scale = 1.0f;
  cfg.model.matcha.length_scale = 1.0f;
  cfg.model.kokoro.model = kokoro_model;
  cfg.model.kokoro.voices = option(argc, argv, "--kokoro-voices");
  cfg.model.kokoro.tokens = option(argc, argv, "--kokoro-tokens");
  cfg.model.kokoro.data_dir = option(argc, argv, "--kokoro-data-dir");
  cfg.model.kokoro.lexicon = option(argc, argv, "--kokoro-lexicon");
  cfg.model.kokoro.length_scale = 1.0f;
  cfg.model.zipvoice.encoder = zipvoice_encoder;
  cfg.model.zipvoice.decoder = option(argc, argv, "--zipvoice-decoder");
  cfg.model.zipvoice.vocoder = option(argc, argv, "--zipvoice-vocoder");
  cfg.model.zipvoice.tokens = option(argc, argv, "--zipvoice-tokens");
  cfg.model.zipvoice.data_dir = option(argc, argv, "--zipvoice-data-dir");
  cfg.model.zipvoice.lexicon = option(argc, argv, "--zipvoice-lexicon");
  /* Preserve the FP32 comparison's reference conditioning and integration. */
  cfg.model.zipvoice.feat_scale = 0.1f;
  cfg.model.zipvoice.t_shift = 0.5f;
  cfg.model.zipvoice.target_rms = 0.1f;
  cfg.model.zipvoice.guidance_scale = 1.0f;
  cfg.model.num_threads = zipvoice_encoder ? 1 : 2;
  cfg.max_num_sentences = 1;
  /* Keep the synthesis parameters used by the evaluated single-voice model. */
  cfg.silence_scale = matcha_model ? 0.2f : 1.0f;
  cfg.rule_fsts = option(argc, argv, "--tts-rule-fsts");
  const char *output = option(argc, argv, "--output-filename");
  const char *speaker = option(argc, argv, "--sid");
  const char *speed = option(argc, argv, "--speed");
  const char *debug = option(argc, argv, "--debug");
  const char *sample_rate = option(argc, argv, "--sample-rate");
  const char *reference_audio = option(argc, argv, "--reference-audio");
  const char *reference_text_file = option(argc, argv, "--reference-text-file");
  const char *num_steps = option(argc, argv, "--num-steps");
  int expected_sample_rate = sample_rate ? atoi(sample_rate) : (matcha_model ? 16000 : 24000);
  cfg.model.debug = debug && !strcmp(debug, "true");
  generation.sid = speaker ? atoi(speaker) : 0;
  generation.speed = speed ? (float)atof(speed) : 1.0f;
  generation.silence_scale = cfg.silence_scale;
  generation.num_steps = zipvoice_encoder ? 8 : 0;
  if (!output ||
      (matcha_model && (!cfg.model.matcha.vocoder || !cfg.model.matcha.tokens ||
        !cfg.model.matcha.data_dir || !cfg.model.matcha.lexicon)) ||
      (kokoro_model && (!cfg.model.kokoro.voices || !cfg.model.kokoro.tokens ||
        !cfg.model.kokoro.data_dir || !cfg.model.kokoro.lexicon)) ||
      (zipvoice_encoder && (!cfg.model.zipvoice.decoder || !cfg.model.zipvoice.vocoder ||
        !cfg.model.zipvoice.tokens || !cfg.model.zipvoice.data_dir ||
        !cfg.model.zipvoice.lexicon || !reference_audio || !reference_text_file ||
        (num_steps && strcmp(num_steps, "8")))) ||
      (!zipvoice_encoder && !cfg.rule_fsts) ||
      (expected_sample_rate != 16000 && expected_sample_rate != 22050 &&
       expected_sample_rate != 24000 && expected_sample_rate != 44100 && expected_sample_rate != 48000) ||
      !isfinite(generation.speed) || generation.speed < 0.5f || generation.speed > 2.0f) {
    fprintf(stderr, "Invalid speech configuration.\n"); return 2;
  }
  char *text = read_text(option(argc, argv, "--text-file"));
  if (!text) { fprintf(stderr, "Cannot read UTF-8 speech text file.\n"); return 2; }
  char *reference_text = NULL;
  const SherpaOnnxWave *reference_wave = NULL;
  if (zipvoice_encoder) {
    reference_text = read_text(reference_text_file);
    reference_wave = SherpaOnnxReadWave(reference_audio);
    if (!reference_text || !reference_wave || reference_wave->sample_rate <= 0 ||
        reference_wave->num_samples <= 0 ||
        (int64_t)reference_wave->num_samples > (int64_t)reference_wave->sample_rate * 30) {
      free(text); free(reference_text);
      if (reference_wave) SherpaOnnxFreeWave(reference_wave);
      fprintf(stderr, "Cannot read the installed voice reference.\n"); return 2;
    }
    generation.reference_text = reference_text;
    generation.reference_audio = reference_wave->samples;
    generation.reference_audio_len = reference_wave->num_samples;
    generation.reference_sample_rate = reference_wave->sample_rate;
  }
  /* The optional GPU component enumerates its actual compiled providers.
   * Availability is not proof of hardware execution: initialization/generation
   * can still fail, and the parent must retry with the independent CPU runtime. */
  cfg.model.provider = select_provider(requested_provider);
  printf("stage=device,device=%s,engine=%s\n", cfg.model.provider,
      zipvoice_encoder ? "zipvoice" : matcha_model ? "matcha" : "kokoro");
  puts("stage=loading"); fflush(stdout);
  const SherpaOnnxOfflineTts *tts = SherpaOnnxCreateOfflineTts(&cfg);
  if (!tts) {
    free(text); free(reference_text);
    if (reference_wave) SherpaOnnxFreeWave(reference_wave);
    fprintf(stderr, "Cannot load installed speech model.\n"); return 3;
  }
  int32_t speakers = SherpaOnnxOfflineTtsNumSpeakers(tts);
  if (generation.sid < 0 || generation.sid >= speakers) {
    free(text); free(reference_text);
    if (reference_wave) SherpaOnnxFreeWave(reference_wave);
    SherpaOnnxDestroyOfflineTts(tts);
    fprintf(stderr, "Unknown voice.\n"); return 2;
  }
  printf("stage=generating, speakers=%d, text_bytes=%zu\n", speakers, strlen(text));
  fflush(stdout);
  const SherpaOnnxGeneratedAudio *audio = SherpaOnnxOfflineTtsGenerateWithConfig(
      tts, text, &generation, progress, NULL);
  free(text);
  free(reference_text);
  if (reference_wave) SherpaOnnxFreeWave(reference_wave);
  int ok = valid_audio(audio, expected_sample_rate);
  if (ok) {
    /* A write failure must not trigger an expensive CPU synthesis retry. */
    puts("stage=writing"); fflush(stdout);
    ok = SherpaOnnxWriteWave(audio->samples, audio->n, audio->sample_rate, output);
  }
  if (audio) SherpaOnnxDestroyOfflineTtsGeneratedAudio(audio);
  SherpaOnnxDestroyOfflineTts(tts);
  if (!ok) { fprintf(stderr, "Speech generation produced no valid audio.\n"); return 4; }
  puts("stage=complete"); fflush(stdout);
  return 0;
}
