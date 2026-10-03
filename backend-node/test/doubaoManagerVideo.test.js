const assert = require('node:assert/strict');
const test = require('node:test');

const {
  extractDoubaoManagerTaskId,
  extractDoubaoManagerVideoUrl,
  extractDoubaoManagerStatus,
  extractDoubaoManagerError,
} = require('../src/services/videoClient');

test('extracts task IDs from common submit response shapes', () => {
  assert.equal(extractDoubaoManagerTaskId({ request_id: 'req-1' }), 'req-1');
  assert.equal(extractDoubaoManagerTaskId({ requestId: 'req-camel' }), 'req-camel');
  assert.equal(extractDoubaoManagerTaskId({ data: { task_id: 42 } }), '42');
  assert.equal(extractDoubaoManagerTaskId({ result: { jobId: 'job-3' } }), 'job-3');
});

test('extracts direct and nested video URLs', () => {
  assert.equal(
    extractDoubaoManagerVideoUrl({
      state: 'completed',
      watermarkFreeUrl: 'https://v11-videoweb-download.doubao.com/video.mp4',
    }),
    'https://v11-videoweb-download.doubao.com/video.mp4'
  );
  assert.equal(
    extractDoubaoManagerVideoUrl({ data: { watermarkedUrl: 'https://v11-vdl.doubao.com/video.mp4' } }),
    'https://v11-vdl.doubao.com/video.mp4'
  );
  assert.equal(
    extractDoubaoManagerVideoUrl({ data: [{ url: 'https://cdn.example.com/a.mp4' }] }),
    'https://cdn.example.com/a.mp4'
  );
  assert.equal(
    extractDoubaoManagerVideoUrl({ result: { video_url: 'https://cdn.example.com/b.mp4' } }),
    'https://cdn.example.com/b.mp4'
  );
  assert.equal(extractDoubaoManagerVideoUrl({ url: 'queued' }), null);
});

test('normalizes status and failure messages', () => {
  assert.equal(extractDoubaoManagerStatus({ data: { task_status: 'COMPLETED' } }), 'completed');
  assert.equal(extractDoubaoManagerStatus({ state: 'running' }), 'running');
  assert.equal(extractDoubaoManagerError({ error: { message: 'render failed' } }), 'render failed');
  assert.equal(extractDoubaoManagerError({ data: { error: 'quota exceeded' } }), 'quota exceeded');
});
