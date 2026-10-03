export async function runUniversalPolishBatch({ shots, settings, request, stopped = () => false, checkPause = async () => {}, onProgress, onDelta, onSuccess, onError }) {
  const results = { polished: 0, failed: [], pending: [], total: shots.length, skipped: false }
  // Caller passes a snapshot: switching episode or rule while running must not retarget it.
  const packId = settings.pack_id || null
  for (let i = 0; i < shots.length; i++) {
    await checkPause()
    if (stopped()) { results.pending.push(...shots.slice(i).map(s => s.id)); break }
    const shot = shots[i]
    onProgress?.(i + 1, shots.length, shot)
    try {
      const draft = shot.draft ?? shot.universal_segment_text ?? ''
      if (!draft.trim()) throw new Error('全能提示词草稿为空，请先生成本镜提示词')
      const data = await request(shot.id, { ...shot.body, draft_universal_segment_text: draft, force_without_reference_images: true, expected_rule_pack_id: packId }, (delta, info) => onDelta?.(shot, delta, info))
      if (!data?.universal_segment_text?.trim()) throw new Error('未收到校验通过的完整润色结果')
      results.polished++
      onSuccess?.(shot, data)
    } catch (e) {
      results.failed.push({ id: shot.id, number: shot.storyboard_number, message: e.message || String(e) })
      onError?.(shot, e.message || String(e))
      if (e.status === 409) { results.pending.push(...shots.slice(i + 1).map(s => s.id)); break }
    }
  }
  return results
}
