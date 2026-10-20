import test from 'node:test';

test('pinned video model inventory includes runtime configurations and verified source files', async () => {
  await import('../scripts/video-generation-verify.mjs');
});
