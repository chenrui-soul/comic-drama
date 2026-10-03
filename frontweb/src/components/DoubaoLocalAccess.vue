<template>
  <section v-if="configs.length" class="local-doubao" aria-label="豆包本地连接">
    <div v-for="config in configs" :key="config.id" class="local-doubao-row">
      <div>
        <strong>{{ config.name }} · 本地连接</strong>
        <p>仅用于豆包视频生成。电脑和豆包管理器需保持运行。</p>
        <p>关闭后停止新的本地请求；已提交给豆包的任务可能继续运行。</p>
      </div>
      <div class="local-doubao-actions">
        <el-tag :type="state[config.id]?.state === 'connected' ? 'success' : 'info'">{{ label(config.id) }}</el-tag>
        <el-switch :model-value="state[config.id]?.enabled === true" :disabled="!state[config.id]?.can_control || busy[config.id]" :loading="busy[config.id]" aria-label="允许连接本机豆包" active-text="允许连接本机豆包" @change="value => toggle(config, value)" />
        <span class="credential-label">连接凭证</span>
        <el-input v-if="credentials[config.id]" v-model="credentials[config.id]" class="credential-input" readonly size="small" />
        <el-button :disabled="!state[config.id]?.can_control || busy[config.id]" @click="generateCredential(config)">{{ credentials[config.id] ? '重新生成' : '生成凭证' }}</el-button>
        <el-button v-if="credentials[config.id]" :disabled="busy[config.id]" @click="copyCredential(config.id)">复制</el-button>
      </div>
    </div>
    <p class="local-doubao-help">在豆包管理工具的“线上连接”中粘贴凭证并保持连接，再打开此开关。重新生成会使旧凭证失效；此开关不影响文本、图片及其他视频服务。</p>
  </section>
</template>
<script setup>
import { computed, ref, watch, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { aiAPI } from '@/api/ai'
const props = defineProps({ list: { type: Array, default: () => [] } })
const configs = computed(() => props.list.filter(c => c.service_type === 'video' && (c.api_protocol === 'doubao_manager' || c.provider === 'doubao_manager')))
const state = ref({}), busy = ref({}), credentials = ref({})
let stopped = false, refreshing = false
function label(id) {
  return ({ disabled: '已关闭', offline: '电脑离线', manager_offline: '豆包管理器未启动', connected: '已连接' })[state.value[id]?.state] || '读取状态中'
}
async function refresh() {
  if (stopped || refreshing || document.hidden) return
  refreshing = true
  try { for (const c of configs.value) if (!busy.value[c.id]) state.value[c.id] = await aiAPI.localAccess(c.id) }
  catch (_) { /* Request interceptor reports errors. */ }
  finally { refreshing = false }
}
async function toggle(config, enabled) {
  busy.value[config.id] = true
  try { const next = await aiAPI.setLocalAccess(config.id, enabled); state.value[config.id] = { ...next, can_control: true }; ElMessage.success(enabled ? '已允许本机豆包连接' : '已关闭本机豆包访问') }
  finally { busy.value[config.id] = false }
}
async function generateCredential(config) {
  busy.value[config.id] = true
  try { const result = await aiAPI.createLocalCredential(config.id); credentials.value[config.id] = result.credential; ElMessage.success('连接凭证已生成，请复制到豆包管理工具'); await refresh() }
  finally { busy.value[config.id] = false }
}
async function copyCredential(id) {
  const value = credentials.value[id]
  if (!value) return
  try { await navigator.clipboard.writeText(value); ElMessage.success('连接凭证已复制') }
  catch (_) { ElMessage.warning('复制失败，请手动选择凭证') }
}
watch(() => configs.value.map(c => c.id).join(','), refresh, { immediate: true })
const timer = setInterval(refresh, 30000)
onUnmounted(() => { stopped = true; clearInterval(timer) })
</script>
<style scoped>
.local-doubao { margin: 0 0 18px; padding: 16px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.local-doubao-row { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; }
.local-doubao p { margin: 6px 0 0; color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.6; }
.local-doubao-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.credential-label { color: var(--el-text-color-secondary); font-size: 13px; }
.credential-input { width: min(360px, 100%); }
.local-doubao-help { padding-top: 8px; }
</style>
