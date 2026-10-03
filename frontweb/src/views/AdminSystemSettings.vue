<template>
  <div class="system-settings">
    <section class="ai-policy" aria-label="用户 AI 配置权限">
      <div>
        <h2>用户 AI 配置</h2>
        <p v-if="allowUserConfig && configuredCount === 0">用户可在工作区内维护自己的 AI 模型配置。平台统一配置尚未建立，保存至少一个启用配置后才能关闭此开关。</p>
        <p v-else>{{ allowUserConfig ? '用户可在工作区内维护自己的 AI 模型配置。' : '用户侧配置为只读，AI 调用统一使用下方的平台配置。' }}</p>
      </div>
      <el-switch
        v-model="allowUserConfig"
        active-text="允许用户自配"
        inactive-text="平台统一配置"
        :loading="savingPolicy"
        :disabled="loadingPolicy || savingPolicy"
        @change="savePolicy"
      />
    </section>
    <AIConfigContent platform-managed />
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { aiAPI } from '@/api/ai'
import AIConfigContent from '@/components/AIConfigContent.vue'

const allowUserConfig = ref(true)
const loadingPolicy = ref(true)
const savingPolicy = ref(false)
const configuredCount = ref(0)

onMounted(async () => {
  try {
    const policy = await aiAPI.getPlatformConfigPolicy()
    allowUserConfig.value = policy.allow_user_ai_config !== false
    configuredCount.value = Number(policy.configured_count || 0)
  } catch (_) {
    ElMessage.error('读取 AI 配置策略失败')
  } finally {
    loadingPolicy.value = false
  }
})

async function savePolicy(enabled) {
  savingPolicy.value = true
  try {
    const policy = await aiAPI.updatePlatformConfigPolicy(enabled)
    allowUserConfig.value = policy.allow_user_ai_config
    configuredCount.value = Number(policy.configured_count ?? configuredCount.value)
    ElMessage.success(enabled ? '已允许用户自配 AI' : '已切换为平台统一 AI 配置')
  } catch (_) {
    allowUserConfig.value = !enabled
  } finally {
    savingPolicy.value = false
  }
}
</script>

<style scoped>
.system-settings{min-width:0}
.ai-policy{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:18px 20px;margin-bottom:18px;background:var(--el-bg-color);border:1px solid var(--el-border-color-lighter);border-radius:6px}
.ai-policy h2{font-size:16px;margin:0 0 6px}.ai-policy p{font-size:13px;color:var(--el-text-color-secondary);margin:0;line-height:1.5}
@media(max-width:600px){.ai-policy{align-items:flex-start;flex-direction:column}}
</style>
