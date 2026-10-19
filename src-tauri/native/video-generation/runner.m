// Open Media's isolated video generation process. Engine sources remain unmodified.
#import <Foundation/Foundation.h>
#include "h3.h"
#include "h3_gpu.h"
#include "h3_metal.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef OPEN_MEDIA_VIDEO_ENGINE_REVISION
#error A pinned engine revision is required
#endif

static void emit(NSDictionary *event) {
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:NULL];
    if (!json) return;
    fwrite(json.bytes, 1, json.length, stdout);
    fputc('\n', stdout);
    fflush(stdout);
}

static int fail(NSString *message) {
    emit(@{@"type": @"error", @"message": message ?: @"Video generation failed"});
    return 1;
}

static NSString *stringValue(id value) {
    return [value isKindOfClass:NSString.class] ? value : nil;
}

static BOOL integerValue(NSDictionary *request, NSString *key, NSInteger fallback,
                         NSInteger minimum, NSInteger maximum, int *output) {
    id value = request[key];
    if (!value) { *output = (int)fallback; return YES; }
    if (![value isKindOfClass:NSNumber.class]) return NO;
    double number = [value doubleValue];
    if (!isfinite(number) || floor(number) != number || number < minimum || number > maximum)
        return NO;
    *output = (int)number;
    return YES;
}

static BOOL absolutePath(NSString *path) {
    return path.length > 0 && path.isAbsolutePath &&
        [path rangeOfString:[NSString stringWithFormat:@"%C", (unichar)0]].location == NSNotFound;
}

static int progress(const char *phase, int completed, int total, void *unused) {
    (void)unused;
    @autoreleasepool {
        emit(@{@"type": @"progress", @"stage": @(phase ?: "generation"),
               @"completed": @(completed), @"total": @(total)});
    }
    return 0;
}

static int probe(BOOL testShaders) {
    h3_device_info info;
    char error[1024] = {0};
    if (!h3_metal_probe(&info, error, sizeof(error))) return fail(@(error));
    if (testShaders) {
        // This checks shader loading and actual GPU computation without weights.
        h3_gpu *gpu = h3_gpu_create("h3_shaders.metal", error, sizeof(error));
        if (!gpu) return fail(@(error));
        const float input[] = {1, 2, 3, 4};
        const float weight[] = {1, 0, 0, 1};
        h3_gpu_tensor *x = h3_gpu_tensor_from_f32(gpu, input, 4);
        h3_gpu_tensor *w = h3_gpu_tensor_from_f32(gpu, weight, 4);
        h3_gpu_tensor *y = h3_gpu_tensor_new_f32(gpu, 4);
        float output[4] = {0};
        BOOL okay = x && w && y && h3_gpu_begin(gpu) &&
            h3_gpu_linear_f32(gpu, y, x, w, NULL, 2, 2, 2) &&
            h3_gpu_submit(gpu) && h3_gpu_tensor_read_f32(y, output, 4);
        for (int index = 0; okay && index < 4; index++)
            okay = fabsf(output[index] - input[index]) < 0.0001f;
        NSString *detail = okay ? nil : @(h3_gpu_error(gpu));
        h3_gpu_tensor_free(x); h3_gpu_tensor_free(w); h3_gpu_tensor_free(y);
        h3_gpu_free(gpu);
        if (!okay) return fail([@"GPU computation check failed: " stringByAppendingString:detail ?: @""]);
    }
    emit(@{@"type": @"device", @"engineRevision": @OPEN_MEDIA_VIDEO_ENGINE_REVISION,
           @"device": @(info.name), @"physicalMemory": @(info.physical_memory),
           @"recommendedWorkingSet": @(info.recommended_working_set),
           @"metal4": @(info.metal4 != 0), @"shaderTested": @(testShaders)});
    return 0;
}

static int generate(NSString *requestPath) {
    NSError *error = nil;
    NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:requestPath error:&error];
    if (!attributes || [attributes fileSize] > 1024 * 1024)
        return fail(@"Request file is missing or exceeds 1 MiB");
    NSData *data = [NSData dataWithContentsOfFile:requestPath options:0 error:&error];
    id parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:&error] : nil;
    if (![parsed isKindOfClass:NSDictionary.class]) return fail(@"Request must be a JSON object");
    NSDictionary *request = parsed;
    NSString *modelDir = stringValue(request[@"modelDir"]);
    NSString *outputPath = stringValue(request[@"outputPath"]);
    NSString *prompt = stringValue(request[@"prompt"]);
    if (!absolutePath(modelDir) || !absolutePath(outputPath))
        return fail(@"Model and output paths must be absolute");
    if (!prompt.length || prompt.length > 10000)
        return fail(@"Prompt must contain 1 to 10000 characters");
    h3_params params = H3_PARAMS_DEFAULT;
    if (!integerValue(request, @"width", 512, 32, 4096, &params.width) ||
        !integerValue(request, @"height", 512, 32, 4096, &params.height) ||
        !integerValue(request, @"frames", 56, 5, 362, &params.frames) ||
        !integerValue(request, @"steps", 20, 2, 100, &params.steps) ||
        !integerValue(request, @"renderWidth", 0, 0, 4096, &params.render_width) ||
        !integerValue(request, @"renderHeight", 0, 0, 4096, &params.render_height) ||
        !integerValue(request, @"denoiseReuse", 1, 1, 3, &params.denoise_reuse) ||
        !integerValue(request, @"ditLayers", 50, 35, 50, &params.dit_layers) ||
        !integerValue(request, @"coreReuse", 1, 1, 6, &params.core_reuse))
        return fail(@"Generation parameter is outside its supported range");
    if (request[@"seed"]) {
        id seed = request[@"seed"];
        if (![seed isKindOfClass:NSNumber.class] || [seed doubleValue] < 0 ||
            [seed doubleValue] > 9007199254740991.0 ||
            floor([seed doubleValue]) != [seed doubleValue]) return fail(@"Invalid seed");
        params.seed = [seed unsignedLongLongValue];
    }
    params.ssd_streaming = request[@"ssdStreaming"] ? [request[@"ssdStreaming"] boolValue] : 1;
    // The upstream text encoder defaults to several prefetched layers on newer
    // GPUs. Match the low-memory setting during text encoding as well as denoising.
    if (params.ssd_streaming) setenv("H3_QWEN_PREFETCH_DEPTH", "1", 0);
    params.output_path = outputPath.fileSystemRepresentation;
    NSString *firstFrame = stringValue(request[@"firstFrame"]);
    NSString *lastFrame = stringValue(request[@"lastFrame"]);
    if ((request[@"firstFrame"] && !absolutePath(firstFrame)) ||
        (request[@"lastFrame"] && !absolutePath(lastFrame))) return fail(@"Invalid frame anchor path");
    params.first_frame = firstFrame.fileSystemRepresentation;
    params.last_frame = lastFrame.fileSystemRepresentation;
    NSArray *references = request[@"references"] ?: @[];
    if (![references isKindOfClass:NSArray.class] || references.count > 12)
        return fail(@"References must be a list of at most 12 inputs");
    h3_reference parsedReferences[12] = {0};
    for (NSUInteger index = 0; index < references.count; index++) {
        NSDictionary *reference = references[index];
        if (![reference isKindOfClass:NSDictionary.class]) return fail(@"Invalid reference object");
        NSString *kind = stringValue(reference[@"kind"]);
        NSString *path = stringValue(reference[@"path"]);
        NSString *audioPath = stringValue(reference[@"audioPath"]);
        if (!absolutePath(path) || (reference[@"audioPath"] && !absolutePath(audioPath)))
            return fail(@"Reference paths must be absolute");
        h3_reference *target = &parsedReferences[index];
        if ([kind isEqualToString:@"image"]) target->kind = H3_REFERENCE_IMAGE;
        else if ([kind isEqualToString:@"video"]) target->kind = H3_REFERENCE_VIDEO;
        else if ([kind isEqualToString:@"audio"]) target->kind = H3_REFERENCE_AUDIO;
        else if ([kind isEqualToString:@"video-audio"]) target->kind = H3_REFERENCE_VIDEO_AUDIO;
        else return fail(@"Unknown reference kind");
        target->path = path.fileSystemRepresentation;
        target->audio_path = audioPath.fileSystemRepresentation;
        target->include_embedded_audio = [reference[@"includeEmbeddedAudio"] boolValue];
    }
    params.references = references.count ? parsedReferences : NULL;
    params.reference_count = references.count;
    params.on_progress = progress;
    emit(@{@"type": @"progress", @"stage": @"loading", @"completed": @0, @"total": @1});
    h3_ctx *context = h3_load_dir(modelDir.fileSystemRepresentation);
    if (!context) return fail(@(h3_last_error(NULL)));
    h3_result *result = h3_generate(context, prompt.UTF8String, &params);
    if (!result) {
        NSString *message = @(h3_last_error(context));
        h3_free(context);
        return fail(message);
    }
    emit(@{@"type": @"result", @"outputPath": outputPath,
           @"width": @(result->width), @"height": @(result->height),
           @"frames": @(result->frames), @"fps": @(result->fps),
           @"sampleRate": @(result->sample_rate), @"seed": @(result->seed)});
    h3_result_free(result);
    h3_free(context);
    return 0;
}

int main(int argc, const char **argv) {
    @autoreleasepool {
        if (@available(macOS 15.0, *)) {
            if (argc == 2 && !strcmp(argv[1], "--probe")) return probe(NO);
            if (argc == 2 && !strcmp(argv[1], "--self-test")) return probe(YES);
            if (argc == 3 && !strcmp(argv[1], "--request")) {
                @try { return generate(@(argv[2])); }
                @catch (NSException *exception) { return fail(exception.reason); }
            }
            return fail(@"Expected --request FILE, --probe, or --self-test");
        }
        return fail(@"Video generation requires macOS 15 or later");
    }
}
