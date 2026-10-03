import request from '@/utils/request'

export default {
  register(payload) {
    return request.post('/auth/register', payload)
  },
  login(payload) {
    return request.post('/auth/login', payload)
  },
  me() {
    return request.get('/auth/me')
  },
  logout() {
    return request.post('/auth/logout')
  },
  organizations() {
    return request.get('/auth/organizations')
  },
  switchOrganization(organization_id) {
    return request.post('/auth/switch-organization', { organization_id })
  },
}
