import { postUniversalSegmentNdjsonStream } from '@/utils/universalPromptStream'
import request from '@/utils/request'

export const storyboardsAPI = {
  promptPolishStatus(episodeId) { return request.get('/episodes/' + episodeId + '/prompt-polish-status') },
  get(id) {
    return request.get(`/storyboards/${id}`)
  },
  create(data) {
    return request.post('/storyboards', data)
  },
  update(id, data) {
    return request.put(`/storyboards/${id}`, data)
  },
  delete(id) {
    return request.delete(`/storyboards/${id}`)
  },
  generateFramePrompt(id, data) {
    return request.post(`/storyboards/${id}/frame-prompt`, data)
  },
  getFramePrompts(id) {
    return request.get(`/storyboards/${id}/frame-prompts`)
  },
  /** 保存/覆盖首帧或尾帧提示词（用于用户手动编辑后保存） */
  saveFramePrompt(id, frameType, data) {
    return request.put(`/storyboards/${id}/frame-prompts/${frameType}`, data || {})
  },
  polishPrompt(id) {
    return request.post(`/storyboards/${id}/polish-prompt`, {})
  },
  /** 全能模式：根据分镜内容 AI 生成片段描述（非流式，兼容旧调用） */
  generateUniversalSegmentPrompt(id, body = {}) {
    return request.post(`/storyboards/${id}/universal-segment-prompt`, body)
  },
  /** 全能模式生成：NDJSON 流式，可选 body.duration、body.force_without_reference_images */
  generateUniversalSegmentPromptStream(id, body, onDelta) {
    return postUniversalSegmentNdjsonStream(
      `/api/v1/storyboards/${id}/universal-segment-prompt-stream`,
      body,
      onDelta
    )
  },
  /**
   * 流式润色全能片段：NDJSON 行 {type:'delta',text} / {type:'done',universal_segment_text} / {type:'error',message}
   * body.draft_universal_segment_text 为当前编辑区全文；可选 duration、force_without_reference_images
   */
  polishUniversalSegmentPromptStream(id, body, onDelta) {
    return postUniversalSegmentNdjsonStream(
      `/api/v1/storyboards/${id}/universal-segment-polish-stream`,
      body,
      onDelta
    )
  },
  insertBefore(id) {
    return request.post(`/storyboards/${id}/insert-before`, {})
  },
  batchInferParams(episodeId, overwrite = false) {
    return request.post('/storyboards/batch-infer-params', { episode_id: episodeId, overwrite })
  },
  upscale(id) {
    return request.post(`/storyboards/${id}/upscale`, {})
  },
  /** 尾帧衔接：提取当前分镜视频最后一帧，设为下一个分镜的首帧 */
  linkTailFrame(id, data) {
    return request.post(`/storyboards/${id}/link-tail-frame`, data || {})
  },
  /** 一键 AI 重新生成/优化本分镜的 layout_description（空间布局合同），自动参考上下分镜 */
  regenerateLayoutDescription(id) {
    return request.post(`/storyboards/${id}/regenerate-layout-description`, {})
  },
  /** 按后端最新规则重建单镜 video_prompt（含音色锚点，不调用 AI） */
  rebuildVideoPrompt(id) {
    return request.post(`/storyboards/${id}/rebuild-video-prompt`, {})
  },
  /** 按对白/旁白拆成多条分镜（每条仅一人说话或仅画外旁白） */
  splitByAudio(id) {
    return request.post(`/storyboards/${id}/split-by-audio`, {})
  },
}
