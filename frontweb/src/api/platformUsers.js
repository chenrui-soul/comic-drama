import request from '@/utils/request'

export const platformUsersAPI = {
  list: params => request.get('/platform/users', { params }),
  update: (id, display_name) => request.patch(`/platform/users/${id}`, { display_name }),
  setAdmin: (id, enabled) => request.patch(`/platform/users/${id}/admin`, { enabled }),
  delete: id => request.delete(`/platform/users/${id}`),
}
