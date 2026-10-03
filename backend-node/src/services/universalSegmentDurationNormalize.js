/** Validate performance timing without silently rescaling dialogue or actions. */
const { assertTimeline } = require('./videoTimelineValidation');
function normalizeUniversalSegmentShotDurations(text, durationLabel, totalSec) {
  if (!text || !durationLabel) return text;
  return assertTimeline(text, Number(totalSec));
}
module.exports = { normalizeUniversalSegmentShotDurations };
