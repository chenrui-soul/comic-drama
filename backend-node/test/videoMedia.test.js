const test = require('node:test');
const assert = require('node:assert/strict');
const { isVideoReference } = require('../src/utils/videoMedia');

test('rejects storyboard image previews as video inputs', () => {
  assert.equal(isVideoReference('projects/demo/images/preview.png'), false);
  assert.equal(isVideoReference('media/images/tailframe_1.jpg'), false);
});

test('accepts local videos and remote video download URLs', () => {
  assert.equal(isVideoReference('projects/demo/videos/vg_1.mp4'), true);
  assert.equal(isVideoReference('https://example.test/download?mime_type=video_mp4&filename=video.mp4'), true);
});
