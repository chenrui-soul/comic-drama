<template>
  <section class="announcement-banner" aria-label="平台公告">
    <div class="announcement-copy">
      <strong>平台公告</strong>
      <span v-if="error">公告暂时无法加载</span>
      <span v-else-if="loading && !latest">正在加载…</span>
      <span v-else>{{ latest?.title || '暂无公告' }}</span>
    </div>
    <el-button text @click="router.push('/announcements')">查看公告</el-button>
  </section>
</template>
<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { announcementsAPI } from '@/api/announcements'
const router = useRouter()
const latest = ref(null), error = ref(false), loading = ref(false)
let timer, disposed = false
async function load() {
  if (document.hidden || loading.value) return
  loading.value = true
  try {
    const result = await announcementsAPI.list({ page_size: 1 })
    if (!disposed) { latest.value = result.items[0] || null; error.value = false }
  } catch (_) { if (!disposed) error.value = true }
  finally { loading.value = false }
}
onMounted(() => {
  load()
  timer = window.setInterval(load, 60000)
  document.addEventListener('visibilitychange', load)
})
onUnmounted(() => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', load) })
</script>
<style scoped>
.announcement-banner{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:20px;padding:10px 18px;border:1px solid var(--el-border-color-light);border-radius:10px;color:var(--el-text-color-primary);background:var(--el-bg-color)}
.announcement-copy{display:flex;align-items:center;gap:16px;min-width:0;font-size:14px}.announcement-copy strong{flex-shrink:0}.announcement-copy span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--el-text-color-secondary)}
@media(max-width:600px){.announcement-copy{align-items:flex-start;flex-direction:column;gap:4px}.announcement-copy span{max-width:200px}}
</style>
