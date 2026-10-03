import request from '@/utils/request'

export const organizationAPI = {
  createWorkspace(name) {
    return request.post('/organization/workspaces', { name })
  },
  deleteWorkspace(id) {
    return request.delete(`/organization/workspaces/${id}`)
  },
  receivedInvitations() {
    return request.get('/auth/invitations')
  },
  respondInvitation(id, accept) {
    return request.post(`/auth/invitations/${id}/${accept ? 'accept' : 'decline'}`)
  },
  members() {
    return request.get('/organization/members')
  },
  invitations() {
    return request.get('/organization/invitations')
  },
  auditLogs(params) {
    return request.get('/organization/audit-logs', { params: params || {} })
  },
  invite(data) {
    return request.post('/organization/invitations', data)
  },
  revokeInvitation(id) {
    return request.delete(`/organization/invitations/${id}`)
  },
  updateRole(userId, role) {
    return request.put(`/organization/members/${userId}/role`, { role })
  },
  removeMember(userId) {
    return request.delete(`/organization/members/${userId}`)
  },
  acceptInvitation(token) {
    return request.post('/organization/invitations/accept', { token })
  },
}
