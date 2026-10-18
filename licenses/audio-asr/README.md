# Offline recognition model attribution

The optional multilingual recognition model is derived from Whisper Small, released by its original authors under the MIT license reproduced unchanged in `LICENSE-MIT.txt`. The conversion files are distributed by `clairemcw/sherpa-onnx-whisper-small-attention`; the conversion distributor is not identified as the original model author. That conversion repository publishes no additional license or provenance description.

Open Media downloads only the three fixed ONNX/token files listed in `scripts/audio-asr-models.lock.json`, checks their byte counts and SHA256 digests, and does not execute code from the model repository. The selected revision is `9a896a02c311676d366ebfda3797753df4153fe2`. The attention outputs are required for actual token timestamps; older exports without those outputs are not interchangeable.

The recognition helper is original Open Media code licensed GPL-3.0-or-later and uses the separately documented shared speech runtime. The model weights are not included in the application installer; users initiate their download.
