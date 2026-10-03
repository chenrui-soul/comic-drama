import { ElMessageBox } from 'element-plus'

export async function assetPromptChoice(api, id, mode) {
  const info = await api.promptStatus(id, mode)
  if (info.state !== 'stale' && !(info.state === 'legacy' && info.selected_pack_id)) return {}
  try {
    await ElMessageBox.confirm('当前提示词与项目所选规则或描述不一致。可以先重新编译，也可以保留原提示词生成本次图片。', '提示词待更新', {
      confirmButtonText: '先重新编译', cancelButtonText: '保留原提示词', distinguishCancelAndClose: true,
    })
    if (mode) await api.generatePrompt(id, undefined, undefined, mode)
    else await api.generatePrompt(id)
    return {}
  } catch (reason) {
    if (reason === 'cancel') return { prompt_policy: 'keep_current' }
    throw reason
  }
}
