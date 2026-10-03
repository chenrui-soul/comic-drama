import request from '@/utils/request'

export const aiAPI = {
  localAccess(id) { return request.get(`/ai-configs/${id}/local-access`, { timeout: 5000 }) },
  setLocalAccess(id, enabled) { return request.put(`/ai-configs/${id}/local-access`, { enabled }) },
  createLocalCredential(id) { return request.post(`/ai-configs/${id}/local-credential`, {}) },
  downloadLocalConnector(id) { return request.post(`/ai-configs/${id}/local-connector`, {}, { responseType: 'blob' }) },
  list(serviceType, platform = false) {
    const params = serviceType ? { service_type: serviceType } : {}
    return request.get(platform ? '/platform/ai-configs' : '/ai-configs', { params })
  },
  get(id, platform = false) {
    return request.get(`${platform ? '/platform/ai-configs' : '/ai-configs'}/${id}`)
  },
  create(body, platform = false) {
    return request.post(platform ? '/platform/ai-configs' : '/ai-configs', body)
  },
  update(id, body, platform = false) {
    return request.put(`${platform ? '/platform/ai-configs' : '/ai-configs'}/${id}`, body)
  },
  delete(id, platform = false) {
    return request.delete(`${platform ? '/platform/ai-configs' : '/ai-configs'}/${id}`)
  },
  testConnection(body) {
    return request.post('/ai-configs/test', body)
  },
  /** 即梦2角色认证：GET /api/business/v1/assets（body: base_url, api_key, limit?, cursor?） */
  listJimeng2MaterialAssets(body) {
    return request.post('/ai-configs/jimeng2-list-assets', body)
  },
  /** ModelArk 私有资产库：action + payload，见 AI 配置页 SD2 资产管理 */
  modelArkAsset(body) {
    return request.post('/ai-configs/model-ark-asset', body)
  },
  getVendorLock() {
    return request.get('/ai-configs/vendor-lock')
  },
  getConfigPolicy() {
    return request.get('/ai-configs/policy')
  },
  getPlatformConfigPolicy() {
    return request.get('/platform/ai-config-policy')
  },
  updatePlatformConfigPolicy(allow_user_ai_config) {
    return request.put('/platform/ai-config-policy', { allow_user_ai_config })
  },
  bulkUpdateKey(apiKey) {
    return request.put('/ai-configs/bulk-update-key', { api_key: apiKey })
  }
}
