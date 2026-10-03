const options = () => ({ httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', path: '/static' });
function setMediaCookie(res, session) {
  res.cookie('media_session', session.token, { ...options(), expires: new Date(session.expires_at) });
  res.set('Cache-Control', 'no-store');
}
function clearMediaCookie(res) { res.clearCookie('media_session', options()); }
module.exports = { setMediaCookie, clearMediaCookie };
