import request from '@/utils/request'

export const creativeSkillRulesAPI = {
  list() { return request.get('/settings/creative-skill-rules') },
  importBase64(filename, content_base64, kind) { return request.post('/settings/creative-skill-rules/import', { filename, content_base64, kind }) },
  importFiles(payload) { return request.post('/settings/creative-skill-rules/import', payload) },
  exportUrl(id) { return `/api/v1/settings/creative-skill-rules/${encodeURIComponent(id)}/export` },
  getProject(dramaId) { return request.get(`/dramas/${dramaId}/creative-skill-rules`) },
  setProject(dramaId, payload) { return request.put(`/dramas/${dramaId}/creative-skill-rules`, payload) },
}
