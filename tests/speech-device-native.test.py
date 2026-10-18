"""Exercise native device selection and crash-visible progress using a C API double.

These tests check process behavior, not hardware acceleration or audio quality.
The packaged runtime smoke test separately synthesizes real audio on each host.
"""

import os
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("optional_speech_zip_smoke", ROOT / "scripts/optional-speech-zip-smoke.py")
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)
HEADER = r"""
#include <stdint.h>
typedef struct {
  const char *acoustic_model, *vocoder, *tokens, *data_dir, *lexicon;
  float noise_scale, length_scale;
} Matcha;
typedef struct {
  const char *model, *voices, *tokens, *data_dir, *lexicon;
  float length_scale;
} Kokoro;
typedef struct {
  const char *encoder, *decoder, *vocoder, *tokens, *data_dir, *lexicon;
  float feat_scale, t_shift, target_rms, guidance_scale;
} ZipVoice;
typedef struct {
  Matcha matcha; Kokoro kokoro; ZipVoice zipvoice;
  int num_threads, debug; const char *provider;
} Model;
typedef struct { Model model; int max_num_sentences; float silence_scale; const char *rule_fsts; } SherpaOnnxOfflineTtsConfig;
typedef struct {
  int sid, num_steps, reference_audio_len, reference_sample_rate;
  float speed, silence_scale; const char *reference_text; const float *reference_audio;
} SherpaOnnxGenerationConfig;
typedef struct { const char *provider; } SherpaOnnxOfflineTts;
typedef struct { const float *samples; int32_t n, sample_rate; } SherpaOnnxGeneratedAudio;
typedef struct { const float *samples; int32_t num_samples, sample_rate; } SherpaOnnxWave;
typedef int32_t (*Callback)(const float *, int32_t, float, void *);
const SherpaOnnxOfflineTts *SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig *);
void SherpaOnnxDestroyOfflineTts(const SherpaOnnxOfflineTts *);
int32_t SherpaOnnxOfflineTtsNumSpeakers(const SherpaOnnxOfflineTts *);
const SherpaOnnxGeneratedAudio *SherpaOnnxOfflineTtsGenerateWithConfig(const SherpaOnnxOfflineTts *, const char *, const SherpaOnnxGenerationConfig *, Callback, void *);
void SherpaOnnxDestroyOfflineTtsGeneratedAudio(const SherpaOnnxGeneratedAudio *);
int SherpaOnnxWriteWave(const float *, int32_t, int32_t, const char *);
const SherpaOnnxWave *SherpaOnnxReadWave(const char *);
void SherpaOnnxFreeWave(const SherpaOnnxWave *);
"""
ORT_HEADER = r"""
#define ORT_API_VERSION 28
typedef struct { int value; } OrtStatus;
typedef struct {
  OrtStatus *(*GetAvailableProviders)(char ***, int *);
  const char *(*GetErrorMessage)(const OrtStatus *);
  void (*ReleaseStatus)(OrtStatus *);
  OrtStatus *(*ReleaseAvailableProviders)(char **, int);
} OrtApi;
typedef struct { const OrtApi *(*GetApi)(int); } OrtApiBase;
const OrtApiBase *OrtGetApiBase(void);
"""
STUB = r"""
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include "sherpa-onnx/c-api/c-api.h"
static SherpaOnnxOfflineTts instance;
static float samples[] = { 0.0f, 0.2f, -0.2f, 0.0f };
static SherpaOnnxGeneratedAudio audio = { samples, 4, 16000 };
static SherpaOnnxWave wave = { samples, 4, 24000 };
static int failure(const char *name) {
  const char *value = getenv("TEST_NATIVE_FAILURE");
  return value && !strcmp(name, value);
}
const SherpaOnnxOfflineTts *SherpaOnnxCreateOfflineTts(const SherpaOnnxOfflineTtsConfig *cfg) {
  if (failure("crash")) exit(71);
  printf("test=create,provider=%s\n", cfg->model.provider);
  if (failure("create")) return NULL;
  instance.provider = cfg->model.provider;
  audio.sample_rate = cfg->model.matcha.acoustic_model ? 16000 : 24000;
  return &instance;
}
void SherpaOnnxDestroyOfflineTts(const SherpaOnnxOfflineTts *value) { (void)value; }
int32_t SherpaOnnxOfflineTtsNumSpeakers(const SherpaOnnxOfflineTts *value) { (void)value; return 1; }
const SherpaOnnxGeneratedAudio *SherpaOnnxOfflineTtsGenerateWithConfig(const SherpaOnnxOfflineTts *value, const char *text, const SherpaOnnxGenerationConfig *config, Callback callback, void *arg) {
  (void)value; (void)text; (void)config;
  callback(samples, 2, 0.5f, arg);
  if (failure("nonfinite")) samples[1] = NAN;
  if (failure("silent")) memset(samples, 0, sizeof(samples));
  if (failure("near-silent")) {
    samples[1] = 0.0000001f; samples[2] = -0.0000001f;
  }
  if (failure("quiet")) {
    samples[1] = 0.001f; samples[2] = -0.001f;
  }
  return failure("generate") ? NULL : &audio;
}
void SherpaOnnxDestroyOfflineTtsGeneratedAudio(const SherpaOnnxGeneratedAudio *value) { (void)value; }
int SherpaOnnxWriteWave(const float *values, int32_t count, int32_t rate, const char *path) {
  (void)values; (void)count; (void)rate;
  if (failure("write")) return 0;
  FILE *file = fopen(path, "wb");
  if (!file) return 0;
  fputs("test-double-output", file);
  fclose(file); return 1;
}
const SherpaOnnxWave *SherpaOnnxReadWave(const char *path) { (void)path; return &wave; }
void SherpaOnnxFreeWave(const SherpaOnnxWave *value) { (void)value; }
#if defined(OPEN_MEDIA_ORT_PROVIDER_QUERY)
#include "onnxruntime_c_api.h"
static OrtStatus error = {1};
static char *provider_names[] = {"CPUExecutionProvider", "CUDAExecutionProvider"};
static OrtStatus *available(char ***names, int *count) {
  if (failure("providers")) return &error;
  *names = provider_names;
  *count = getenv("TEST_NATIVE_CUDA") ? 2 : 1;
  return NULL;
}
static const char *message(const OrtStatus *value) { (void)value; return "provider query failed"; }
static void release_status(OrtStatus *value) { (void)value; }
static OrtStatus *release_providers(char **names, int count) { (void)names; (void)count; return NULL; }
static const OrtApi api = {available, message, release_status, release_providers};
static const OrtApi *get_api(int version) { (void)version; return failure("api-version") ? NULL : &api; }
static const OrtApiBase base = {get_api};
const OrtApiBase *OrtGetApiBase(void) { return &base; }
#endif
"""


@unittest.skipUnless(shutil.which("cc"), "A C compiler is required for native process tests")
class NativeSpeechDeviceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="speech-device-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        header = cls.directory / "sherpa-onnx/c-api/c-api.h"
        header.parent.mkdir(parents=True)
        header.write_text(HEADER)
        (cls.directory / "onnxruntime_c_api.h").write_text(ORT_HEADER)
        stub = cls.directory / "stub.c"
        stub.write_text(STUB)
        cls.programs = {}
        for apple in (False, True, "gpu"):
            program = cls.directory / ("gpu-helper" if apple == "gpu" else "apple-helper" if apple else "cpu-helper")
            subprocess.run([
                "cc", "-std=c11", "-Wall", "-Wextra", "-Werror",
                *( ["-D__APPLE__=1"] if apple is True else ["-U__APPLE__"] ),
                *( ["-DOPEN_MEDIA_ORT_PROVIDER_QUERY=1"] if apple == "gpu" else [] ),
                "-I", str(cls.directory), str(ROOT / "scripts/speech-runtime-runner.c"),
                str(stub), "-o", str(program),
            ], check=True, capture_output=True, text=True)
            cls.programs[apple] = program
        (cls.directory / "text.txt").write_text("这是一段测试文本。", encoding="utf-8")

    def run_helper(self, *, apple=False, provider=None, engine="matcha", failure=None, cuda=False):
        if engine == "matcha":
            model = ["--matcha-acoustic-model=model", "--matcha-vocoder=vocoder", "--matcha-tokens=tokens", "--matcha-data-dir=data", "--matcha-lexicon=lexicon"]
        elif engine == "zipvoice":
            model = ["--zipvoice-encoder=encoder", "--zipvoice-decoder=decoder", "--zipvoice-vocoder=vocoder", "--zipvoice-tokens=tokens", "--zipvoice-data-dir=data", "--zipvoice-lexicon=lexicon", "--reference-audio=reference", f"--reference-text-file={self.directory / 'text.txt'}"]
        else:
            model = ["--kokoro-model=model", "--kokoro-voices=voices", "--kokoro-tokens=tokens", "--kokoro-data-dir=data", "--kokoro-lexicon=lexicon", "--sample-rate=24000"]
        env = dict(os.environ)
        env.pop("TEST_NATIVE_FAILURE", None)
        env.pop("TEST_NATIVE_CUDA", None)
        if cuda:
            env["TEST_NATIVE_CUDA"] = "1"
        if failure:
            env["TEST_NATIVE_FAILURE"] = failure
        return subprocess.run([
            str(self.programs[apple]), *model, "--tts-rule-fsts=rules",
            f"--text-file={self.directory / 'text.txt'}",
            f"--output-filename={self.directory / 'output.wav'}",
            *([] if provider is None else [f"--provider={provider}"]),
        ], capture_output=True, text=True, env=env, timeout=10)

    def test_apple_prefers_coreml_for_every_native_engine(self):
        for engine in ("matcha", "zipvoice", "kokoro"):
            for provider in (None, "auto", "coreml"):
                with self.subTest(engine=engine, provider=provider):
                    result = self.run_helper(apple=True, provider=provider, engine=engine)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn(f"stage=device,device=coreml,engine={engine}\n", result.stdout)
                    self.assertIn("test=create,provider=coreml", result.stdout)
                    self.assertIn("sample=2, progress=0.500000", result.stdout)
                    self.assertIn("stage=complete", result.stdout)

    def test_explicit_cpu_supports_a_fresh_parent_process_retry(self):
        for apple in (False, True):
            result = self.run_helper(apple=apple, provider="cpu")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("stage=device,device=cpu", result.stdout)
            self.assertNotIn("provider=coreml", result.stdout)

    def test_cpu_runtime_does_not_claim_a_missing_gpu_provider(self):
        for provider in (None, "auto", "coreml", "cuda"):
            result = self.run_helper(provider=provider)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("stage=device,device=cpu", result.stdout)
            self.assertNotIn("stage=device,device=coreml", result.stdout)
            self.assertEqual("stage=fallback," in result.stdout, provider in ("coreml", "cuda"))
            if provider in ("coreml", "cuda"):
                self.assertIn(f"from={provider},device=cpu,reason=runtime_provider_unavailable", result.stdout)

    def test_optional_runtime_queries_real_provider_inventory(self):
        for engine in ("matcha", "zipvoice", "kokoro"):
            for provider in (None, "auto", "cuda"):
                result = self.run_helper(apple="gpu", provider=provider, cuda=True, engine=engine)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"stage=device,device=cuda,engine={engine}", result.stdout)
                self.assertIn("test=create,provider=cuda", result.stdout)
        for cuda, failure, expected in [(False, None, "cpu"), (True, "providers", "cpu"), (True, "api-version", "cpu")]:
            result = self.run_helper(apple="gpu", provider="cuda", cuda=cuda, failure=failure)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f"stage=device,device={expected}", result.stdout)
            self.assertIn("runtime_provider_unavailable", result.stdout)
        cpu = self.run_helper(apple="gpu", provider="cpu", cuda=True)
        self.assertIn("test=create,provider=cpu", cpu.stdout)

    def test_self_test_checks_runtime_without_claiming_gpu_inference(self):
        result = subprocess.run([self.programs["gpu"], "--self-test"], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout.splitlines()[-1])
        self.assertEqual(report["selfTest"], "runtime-load-and-capabilities")
        self.assertFalse(report["gpuInferenceVerified"])
        self.assertNotIn("test=create", result.stdout)

    def test_invalid_provider_fails_before_loading_a_model(self):
        for provider in ("directml", "coreml:arbitrary.conf", "", "cpu\ninvalid"):
            result = self.run_helper(apple=True, provider=provider)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn("test=create", result.stdout)
            self.assertNotIn("stage=complete", result.stdout)

    def test_native_failures_keep_device_visible_and_do_not_retry_inside_helper(self):
        for failure, expected in (("create", 3), ("generate", 4), ("crash", 71)):
            with self.subTest(failure=failure):
                result = self.run_helper(apple=True, failure=failure)
                self.assertEqual(result.returncode, expected)
                self.assertTrue(result.stdout.startswith("stage=device,device=coreml,engine=matcha\nstage=loading\n"))
                self.assertLessEqual(result.stdout.count("test=create"), 1)
                self.assertNotIn("stage=device,device=cpu", result.stdout)
                self.assertNotIn("stage=complete", result.stdout)

    def test_write_failure_is_distinguishable_from_a_provider_failure(self):
        result = self.run_helper(apple=True, failure="write")
        self.assertEqual(result.returncode, 4)
        self.assertIn("stage=writing\n", result.stdout)
        self.assertNotIn("stage=complete", result.stdout)
        failed_generation = self.run_helper(apple=True, failure="generate")
        self.assertNotIn("stage=writing", failed_generation.stdout)

    def test_invalid_or_silent_gpu_output_fails_before_pcm_conversion(self):
        for failure in ("nonfinite", "silent", "near-silent"):
            with self.subTest(failure=failure):
                result = self.run_helper(apple=True, failure=failure)
                self.assertEqual(result.returncode, 4)
                self.assertNotIn("stage=writing", result.stdout)
                self.assertNotIn("stage=complete", result.stdout)
        quiet = self.run_helper(apple=True, failure="quiet")
        self.assertEqual(quiet.returncode, 0, quiet.stderr)
        self.assertIn("stage=writing", quiet.stdout)


class NativeVerificationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="speech-verify-test-")
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.script = self.directory / "native-process.py"
        self.audio = self.directory / "output.wav"
        self.log = self.directory / "generation.log"
        self.calls = self.directory / "calls.jsonl"
        self.script.write_text('''
import json, sys, time
from pathlib import Path
output = Path(next(arg.split("=", 1)[1] for arg in sys.argv if arg.startswith("--output-filename=")))
calls = output.with_name("calls.jsonl")
with calls.open("a") as stream: stream.write(json.dumps(sys.argv[1:]) + "\\n")
mode = sys.argv[1]
if "--provider=cpu" in sys.argv:
    if output.exists(): raise RuntimeError("partial GPU audio was not removed")
    print("stage=device,device=cpu", flush=True)
    if mode == "both-fail":
        print("CPU failure", file=sys.stderr)
        sys.exit(4)
    output.write_text("CPU test output")
    print("stage=writing\\nstage=complete", flush=True)
else:
    print("stage=device,device=coreml", flush=True)
    if mode == "timeout": time.sleep(10)
    output.write_text("incomplete GPU test output")
    if mode == "writing": print("stage=writing", flush=True)
    print("original CoreML failure", file=sys.stderr)
    sys.exit(4)
''')

    def execute(self, mode="fallback", timeout=3):
        return smoke.run_native_speech([sys.executable, self.script, mode, "--provider=coreml",
                                       f"--output-filename={self.audio}"], self.log, self.audio, timeout)

    def test_retry_rules_use_last_device_and_do_not_retry_writing_or_cancellation(self):
        device = "stage=device,device=coreml\n"
        def result(log=device, code=4):
            return subprocess.CompletedProcess([], code, stdout=log, stderr="failure")
        self.assertTrue(smoke.should_retry_native_cpu(result()))
        self.assertTrue(smoke.should_retry_native_cpu(result(code=-6)))
        self.assertFalse(smoke.should_retry_native_cpu(result(), retried=True))
        for code in (0, -1, -2, -9, -15):
            self.assertFalse(smoke.should_retry_native_cpu(result(code=code)))
        for suffix in ("stage=writing\n", "stage=writing,bytes=1\n", "stage=complete\n",
                       "stage=device,device=cpu\n", "stage=device,device=unknown\n",
                       "stage=fallback,from=coreml,device=cpu,reason=unavailable\n"):
            self.assertFalse(smoke.should_retry_native_cpu(result(device + suffix)))
        self.assertFalse(smoke.should_retry_native_cpu(result("")))

    def test_one_cpu_retry_preserves_original_failure_and_reports_real_backend(self):
        execution = self.execute()
        self.assertEqual(execution["backend"], "cpu")
        self.assertEqual(execution["fallbackFrom"], "coreml")
        self.assertEqual(len(execution["attempts"]), 2)
        self.assertEqual(execution["attempts"][0]["error"], "original CoreML failure")
        calls = [json.loads(line) for line in self.calls.read_text().splitlines()]
        self.assertEqual(len(calls), 2)
        self.assertIn("--provider=cpu", calls[1])
        self.assertNotIn("--provider=coreml", calls[1])
        self.assertEqual(self.audio.read_text(), "CPU test output")
        self.assertIn("original CoreML failure", self.log.read_text())
        self.assertIn("stage=fallback,from=coreml,device=cpu", self.log.read_text())

    def test_write_failure_does_not_start_cpu_synthesis(self):
        with self.assertRaisesRegex(RuntimeError, "Native speech failed"):
            self.execute("writing")
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertFalse(self.audio.exists())

    def test_failed_cpu_retry_does_not_loop(self):
        with self.assertRaisesRegex(RuntimeError, "Native speech failed"):
            self.execute("both-fail")
        self.assertEqual(len(self.calls.read_text().splitlines()), 2)
        self.assertIn("original CoreML failure", self.log.read_text())
        self.assertIn("CPU failure", self.log.read_text())

    def test_timeout_is_preserved_without_cpu_retry(self):
        with self.assertRaises(subprocess.TimeoutExpired):
            self.execute("timeout", timeout=0.2)
        self.assertEqual(len(self.calls.read_text().splitlines()), 1)
        self.assertNotIn("stage=fallback", self.log.read_text())
        self.assertIn("timed out", self.log.read_text())


if __name__ == "__main__":
    unittest.main()
