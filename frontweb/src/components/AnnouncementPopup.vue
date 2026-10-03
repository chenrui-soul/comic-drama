<template>
  <aside v-if="announcement" class="announcement-popup" aria-live="polite" aria-label="未读平台公告">
    <header class="popup-heading">
      <strong>平台公告</strong>
      <el-button text circle aria-label="关闭公告并标记为已读" :loading="busy" @click="markRead"><el-icon><Close /></el-icon></el-button>
    </header>
    <h2>{{ announcement.title }}</h2>
    <p class="popup-content">{{ announcement.content }}</p>
    <footer>
      <el-button type="primary" :loading="busy" @click="viewAnnouncement">查看公告</el-button>
    </footer>
  </aside>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { Close } from '@element-plus/icons-vue'
import { useRoute, useRouter } from 'vue-router'
import { getAuthToken } from '@/utils/auth'
import { announcementsAPI } from '@/api/announcements'

const route = useRoute()
const router = useRouter()
const announcement = ref(null)
const busy = ref(false)
let timer
let disposed = false

function canShow() {
  return Boolean(getAuthToken()) && !['login', 'register', 'announcements', 'admin-announcements'].includes(String(route.name || ''))
}

async function loadUnread() {
  if (disposed || !canShow() || busy.value) return
  try {
    const result = await announcementsAPI.unread()
    if (!disposed && canShow()) announcement.value = result.item || null
  } catch (_) {
    // Keep the workspace usable when announcement loading is unavailable.
  }
}

async function markRead() {
  if (!announcement.value || busy.value) return
  const current = announcement.value
  busy.value = true
  let marked = false
  try {
    await announcementsAPI.markRead(current.id)
    announcement.value = null
    marked = true
  } catch (_) {
    // Keep the notice visible so the user can retry.
  } finally {
    busy.value = false
  }
  if (marked) await loadUnread()
}

async function viewAnnouncement() {
  if (!announcement.value || busy.value) return
  const currentId = announcement.value.id
  busy.value = true
  try {
    await announcementsAPI.markRead(currentId)
    announcement.value = null
    await router.push('/announcements')
  } catch (_) {
    // Keep the notice visible so the user can retry.
  } finally {
    busy.value = false
  }
}

watch(() => route.fullPath, loadUnread)
onMounted(() => {
  loadUnread()
  timer = window.setInterval(loadUnread, 60000)
})
onUnmounted(() => {
  disposed = true
  window.clearInterval(timer)
})
</script>

<style scoped>
.announcement-popup{position:fixed;z-index:3000;right:24px;bottom:24px;width:min(380px,calc(100vw - 32px));max-height:min(70vh,560px);display:flex;flex-direction:column;gap:12px;padding:18px;background:var(--el-bg-color);border:1px solid var(--el-border-color);border-radius:8px;box-shadow:0 8px 28px rgba(0,0,0,.2);color:var(--el-text-color-primary)}
.popup-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--el-color-primary);font-size:13px}
.popup-heading :deep(.el-button){width:30px;height:30px}
.announcement-popup h2{margin:0;font-size:17px;line-height:1.45;overflow-wrap:anywhere}
.popup-content{margin:0;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.65;color:var(--el-text-color-regular)}
.announcement-popup footer{display:flex;justify-content:flex-end}
@media(max-width:600px){.announcement-popup{right:12px;bottom:12px;width:calc(100vw - 24px);padding:16px}}
</style>
