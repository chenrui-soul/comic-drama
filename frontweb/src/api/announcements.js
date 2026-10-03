import request from '@/utils/request'

export const announcementsAPI = {
  list: params => request.get('/announcements', { params }),
  unread: () => request.get('/announcements/unread'),
  markRead: id => request.post(`/announcements/${id}/read`),
  create: data => request.post('/announcements', data),
  update: (id, data) => request.put(`/announcements/${id}`, data),
}
