/* Publish actual artifact evidence through the independently readable checks API. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = async function publishMusicEvidence({ github, context, directory, headSha, originalRunId }) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  let report, audio, verificationError;
  try {
    report = read('report.json');
    if (report.sourceCommit !== headSha) throw new Error('Evidence does not match the source run commit');
    if (report.actualModelGeneration === 'passed') {
      audio = read('audio-validation.json');
      const bytes = fs.readFileSync(path.join(directory, 'generated.wav'));
      const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
      const duration = Number(audio.ffprobe?.format?.duration);
      const stream = audio.ffprobe?.streams?.[0];
      if (report.device !== 'cpu' || report.modelId !== 'ace-step-1.5-turbo' || report.seconds !== 10 || report.steps !== 8
          || audio.sha256 !== sha256 || report.audio?.sha256 !== sha256 || !(audio.rms > 0) || !(audio.nonzeroSamples > 0)
          || duration < 9.5 || duration > 10.5 || !Number.isFinite(duration)
          || stream?.codec_name !== 'pcm_s16le' || Number(stream?.sample_rate) !== 48000
          || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('Saved WAV or audio validation differs from the reported success');
      }
    }
  } catch (error) {
    verificationError = String(error.message || error);
  }
  const success = !verificationError && report?.actualModelGeneration === 'passed';
  const sections = [];
  for (const filename of ['report.json', 'audio-validation.json', 'resource-usage.txt', 'events.jsonl', 'inference.log']) {
    const file = path.join(directory, filename);
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8').slice(-8000).replace(/```/g, "'''");
      sections.push(`### ${filename}\n\n\`\`\`text\n${content}\n\`\`\``);
    }
  }
  await github.rest.checks.create({
    owner: context.repo.owner, repo: context.repo.repo, name: 'Real music model evidence — Linux CPU',
    head_sha: headSha, status: 'completed', conclusion: success ? 'success' : 'failure',
    completed_at: new Date().toISOString(),
    details_url: `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${originalRunId}`,
    output: {
      title: `Real ten-second music generation: ${success ? 'passed' : 'failed'}`,
      summary: `Source run ${originalRunId}; source commit ${headSha}.\n\n${verificationError || 'Original report and saved WAV integrity inspected.'}\n\nThis is an actual model compatibility and nonzero-output check. Musical quality and GPU performance were not evaluated.`,
      text: sections.join('\n\n'),
    },
  });
  if (!success) throw new Error(verificationError || report?.error || 'The real model probe did not pass');
};
