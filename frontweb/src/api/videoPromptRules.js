import request from '@/utils/request'

export const videoPromptRulesAPI = {
  list() { return request.get('/settings/video-prompt-rules') },
  importBase64(filename, content_base64) { return request.post('/settings/video-prompt-rules/import', { filename, content_base64 }) },
  importFiles(payload) { return request.post('/settings/video-prompt-rules/import', payload) },
  exportUrl(id) { return `/api/v1/settings/video-prompt-rules/${encodeURIComponent(id)}/export` },
  getProject(dramaId) { return request.get(`/dramas/${dramaId}/video-prompt-rules`) },
  setProject(dramaId, payload) { return request.put(`/dramas/${dramaId}/video-prompt-rules`, payload) },
}
