export function secondsLabel(milliseconds) {
  return typeof milliseconds === 'number' && Number.isFinite(milliseconds) && milliseconds >= 0
    ? `${Number((milliseconds / 1000).toFixed(3))} 秒` : '未计算'
}
export function readPlan(payload) {
  try {
    const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch { return null }
}
export function settingsSummary(settings) {
  if (!settings) return '旧记录未保存完整参数快照'
  const count = settings.storyboard_count_source === 'manual' ? `${settings.storyboard_count} 段（人工）` : `自动（参考 ${settings.storyboard_count ?? '—'} 段）`
  const total = settings.total_source === 'manual' ? `${settings.total_seconds} 秒（人工）` : `自动（参考 ${settings.total_seconds ?? '—'} 秒）`
  return `${settings.duration_mode === 'capacity' ? '每段最多' : '每段约'} ${settings.clip_seconds} 秒；数量：${count}；总时长：${total}；${settings.universal_omni_storyboard ? '全能模式' : '经典模式'}；${settings.include_narration ? '生成旁白' : '不加旁白'}；${settings.aspect_ratio || '默认画幅'}；${settings.language === 'en' ? '英文' : '中文'}；参考图：${({ single: '单张', quad_grid: '四宫格', nine_grid: '九宫格' })[settings.sequence_mode] || settings.sequence_mode || '单张'}；${settings.storyboard_use_first_last_frame ? '首尾帧开启' : '首尾帧关闭'}`
}
