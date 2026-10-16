#!/usr/bin/env python3
"""Audit bundled voice representatives using existing real WAVs; no synthesis or build.
Requires Python 3, numpy and scipy. This is catalogue curation, not speaker verification.
"""
import argparse, collections, hashlib, json, pathlib, re, wave
import numpy as np
import scipy
from scipy.fft import dct
from scipy.signal import stft
from scipy.spatial.distance import pdist, squareform
from scipy.stats import spearmanr

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=pathlib.Path, required=True)
parser.add_argument('--samples', type=pathlib.Path, required=True)
parser.add_argument('--output', type=pathlib.Path, required=True)
args = parser.parse_args()
root, samples, output = args.repo, args.samples, args.output
output.mkdir(parents=True, exist_ok=True)
runtime = root / 'src-tauri/resources/speech'
manifest = json.loads((runtime / 'manifest.json').read_text())
voices = sorted(manifest['voices'], key=lambda voice: voice['speakerId'])
assert [voice['speakerId'] for voice in voices] == list(range(103))
profiles = dict(re.findall(r"\s+(\w+): \{ category: '[^']+', speakerId: \d+, style: '([^']+)'", (root / 'src/core/voice-profiles.ts').read_text()))
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
weight_path = runtime / manifest['model']['voices']
weights = np.fromfile(weight_path, dtype='<f4').reshape(103, 510, 256)
assert np.isfinite(weights).all()
embedding = weights.mean(axis=1)
embedding /= np.linalg.norm(embedding, axis=1, keepdims=True)
cosine = embedding @ embedding.T
np.fill_diagonal(cosine, 1)
features, sample_records = [], []
for voice in voices:
    path = samples / (voice['id'] + '.wav')
    with wave.open(str(path)) as wav:
        assert wav.getnchannels() == 1 and wav.getsampwidth() == 2
        rate = wav.getframerate()
        assert rate == 24000
        signal = np.frombuffer(wav.readframes(wav.getnframes()), '<i2').astype(float) / 32768
    _, _, spectrum = stft(signal, fs=rate, window='hann', nperseg=600, noverlap=360, nfft=1024, boundary=None)
    power = np.abs(spectrum) ** 2
    power = power[:, power.sum(axis=0) > 0.00012]
    assert power.shape[1] > 0
    mel = lambda hz: 2595 * np.log10(1 + hz / 700)
    hertz = lambda value: 700 * (10 ** (value / 2595) - 1)
    edges = hertz(np.linspace(mel(70), mel(10000), 42))
    frequencies = np.fft.rfftfreq(1024, 1 / rate)
    filters = np.zeros((40, len(frequencies)))
    for index in range(40):
        filters[index] = np.maximum(0, np.minimum((frequencies - edges[index]) / (edges[index + 1] - edges[index]), (edges[index + 2] - frequencies) / (edges[index + 2] - edges[index + 1])))
    coefficients = dct(np.log(np.maximum(filters @ power, 1e-10)), axis=0, norm='ortho')[1:17]
    features.append(np.r_[coefficients.mean(axis=1), coefficients.std(axis=1)])
    sample_records.append({'id': voice['id'], 'speakerId': voice['speakerId'], 'wavSha256': sha(path), 'durationSeconds': round(len(signal) / rate, 6), 'voiceWeightSha256': hashlib.sha256(weights[voice['speakerId']].tobytes()).hexdigest()})
features = np.asarray(features)
groups, category_evidence = [], {}
for gender in ['male', 'female']:
    ids = [v['speakerId'] for v in voices if v['language'].startswith('zh') and v['gender'] == gender]
    similarity = cosine[np.ix_(ids, ids)]
    category_features = features[ids]
    standardized = (category_features - category_features.mean(axis=0)) / np.maximum(category_features.std(axis=0), 1e-8)
    distance = squareform(pdist(standardized)) / np.sqrt(32)
    eligible = (similarity >= 0.70) & (distance <= 1.40)
    uncovered, chosen = set(range(len(ids))), []
    if gender == 'female':
        chosen.append(ids.index(3))  # Keep the established global default zf_001.
        uncovered -= set(np.where(eligible[chosen[0]])[0])
    while uncovered:
        # Coverage first; deterministic similarity and speakerId tie-breaks.
        scores = [(len(set(np.where(row)[0]) & uncovered), float(sum(similarity[i, sorted(uncovered)])), -i) for i, row in enumerate(eligible)]
        representative = -max(scores)[2]
        chosen.append(representative)
        uncovered -= set(np.where(eligible[representative])[0])
    assignments = {i: [] for i in chosen}
    for member in range(len(ids)):
        representative = member if member in chosen else max([i for i in chosen if eligible[i, member]], key=lambda i: (float(similarity[i, member]), -i))
        assignments[representative].append(member)
    for representative in sorted(chosen, key=lambda i: ids[i]):
        v = voices[ids[representative]]
        evidence = [{'id': voices[ids[i]]['id'], 'weightCosine': round(float(similarity[representative, i]), 6), 'acousticDistance': round(float(distance[representative, i]), 6)} for i in assignments[representative]]
        groups.append({'category': 'zh-' + gender, 'locale': v['language'], 'representativeId': v['id'], 'speakerId': v['speakerId'], 'style': profiles[v['id']], 'members': [item['id'] for item in evidence], 'evidence': evidence})
    pairs = np.triu_indices(len(ids), 1)
    category_evidence['zh-' + gender] = {'voiceCount': len(ids), 'representativeCount': len(chosen), 'weightAcousticDistanceSpearman': float(spearmanr((1 - similarity)[pairs], distance[pairs]).statistic), 'acousticDistancePercentiles': dict(zip(['0', '25', '50', '75', '95', '100'], np.percentile(distance[pairs], [0, 25, 50, 75, 95, 100]).tolist()))}
for v in voices:
    if v['language'].startswith('en'):
        groups.append({'category': 'en-female', 'locale': v['language'], 'representativeId': v['id'], 'speakerId': v['speakerId'], 'style': profiles[v['id']], 'members': [v['id']], 'evidence': [{'id': v['id'], 'weightCosine': 1, 'acousticDistance': 0}]})
member_ids = [v for group in groups for v in group['members']]
assert len(member_ids) == 103 and len(set(member_ids)) == 103
assert 'zf_001' in [group['representativeId'] for group in groups]
for group in groups:
    for item in group['evidence']:
        assert item['weightCosine'] >= 0.70 and item['acousticDistance'] <= 1.40
method = {
    'description': 'Greedy representative coverage within Chinese gender categories; every member must directly meet both bounds with its representative. Retain zf_001 and all 3 English voices. Assign to the most similar eligible representative; representatives assign to themselves. Never use transitive equivalence.',
    'weightFeatures': 'Mean across 510 length-conditioned vectors, cosine similarity of resulting 256 dimensions.',
    'acousticFeatures': 'Real same-text WAV; 24kHz Hann STFT length600 hop240 FFT1024; frames power sum >0.00012; 40 mel bands 70–10000Hz; natural-log power DCT-II normalized, coefficients1–16 mean+std. Standardize32 dimensions within Chinese gender; Euclidean distance /sqrt(32).',
    'minimumWeightCosine': 0.70, 'maximumAcousticDistance': 1.40,
    'selectionTieBreak': 'Maximum uncovered eligible member count, then highest total latent similarity across remaining members, then lower speakerId.',
    'limitations': 'Engineering thresholds for a smaller default catalogue, not perceptual identity. Single short fixed text; no human blind listening or trained speaker identity model. MFCC captures spectral shape and some pronunciation, not all emotion/accent. Source audio used historical silenceScale0.2. Current1.0 changes pauses, so do not describe historical durations as current synthesis. No model resources or old-project IDs should be removed.',
}
source = {'archiveSha256': re.search(r"archiveSha256: '([0-9a-f]+)'", (root / 'src/core/voice-profiles.ts').read_text()).group(1), 'weightsSha256': sha(weight_path), 'modelSha256': sha(runtime / manifest['model']['file']), 'audioSampleCount': len(sample_records), 'chineseText': (samples / 'sample-zh.txt').read_text().strip(), 'englishText': (samples / 'sample-en.txt').read_text().strip(), 'speed': 1, 'silenceScale': 0.2, 'sampleRate': 24000, 'allWaveformsDistinct': len({item['wavSha256'] for item in sample_records}) == 103, 'allVoiceWeightBlocksDistinct': len({item['voiceWeightSha256'] for item in sample_records}) == 103, 'numpyVersion': np.__version__, 'scipyVersion': scipy.__version__}
report = {'source': source, 'method': method, 'representativeIds': [g['representativeId'] for g in groups], 'groups': groups}
(output / 'catalog.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
(output / 'sample-hashes.json').write_text(json.dumps(sample_records, ensure_ascii=False, indent=2) + '\n')
evidence = [item for group in groups for item in group['evidence']]
summary = {'representativeCount': len(groups), 'categoryEvidence': category_evidence, 'minimumRepresentativeCosine': min(evidence, key=lambda item: item['weightCosine']), 'maximumRepresentativeAcousticDistance': max(evidence, key=lambda item: item['acousticDistance']), 'styleCoverage': {category: dict(collections.Counter(g['style'] for g in groups if g['category'] == category)) for category in ['zh-male', 'zh-female', 'en-female']}, 'unrepresentedStyle': 'zh-female/relaxed: original voices are covered by other representatives; no group was altered to force style coverage.', 'groupBounds': [{'representativeId': g['representativeId'], 'minimumWeightCosine': min(item['weightCosine'] for item in g['evidence']), 'maximumAcousticDistance': max(item['acousticDistance'] for item in g['evidence'])} for g in groups]}
(output / 'report.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(summary, ensure_ascii=False, indent=2))
