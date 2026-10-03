const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi']);

function stripQuery(value) {
  return String(value || '').trim().toLowerCase().split(/[?#]/, 1)[0];
}

/** 判断数据库路径或远程地址是否明确指向视频。 */
function isVideoReference(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return false;
  const pathname = stripQuery(raw);
  const dot = pathname.lastIndexOf('.');
  if (dot >= 0 && VIDEO_EXTENSIONS.has(pathname.slice(dot))) return true;
  return /(?:mime_type|content_type)=video(?:[_-](?:mp4|webm|mov))?\b/.test(raw)
    || /(?:filename|file_name)=[^&]*(?:\.mp4|\.webm|\.mov|\.m4v)(?:&|$)/.test(raw);
}

module.exports = { isVideoReference };
