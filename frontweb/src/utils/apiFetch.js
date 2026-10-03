import { getAuthToken } from './auth.js'

// Raw/streaming API calls need the same current session as axios requests.
export function apiFetch(url, options = {}) {
  if (typeof url !== 'string' || !url.startsWith('/api/v1/')) {
    throw new Error('apiFetch 仅支持本站 API 路径')
  }
  const headers = new Headers(options.headers)
  const token = getAuthToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  else headers.delete('Authorization')
  return fetch(url, { ...options, headers })
}
