const TOKEN_KEY = 'localminidrama_auth_token';
const USER_KEY = 'localminidrama_auth_user';

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function saveAuthSession(session, user) {
  localStorage.setItem(TOKEN_KEY, session?.token || '');
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getAuthUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch (_) {
    return null;
  }
}

export function clearAuthSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
