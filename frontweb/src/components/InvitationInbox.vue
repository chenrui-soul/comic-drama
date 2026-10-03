<template>
  <section id="invitations" class="inbox">
    <div class="inbox-heading"><h2>收到的工作区邀请</h2><el-button text :loading="loading" @click="refresh">刷新</el-button></div>
    <p>邀请会发送到你的账号。接受后即可进入对方的工作区。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="!loading && !invitations.length">暂无待处理邀请</p>
    <div v-for="invite in invitations" :key="invite.id" class="inbox-row">
      <div><strong>{{ invite.organization_name }}</strong><p>{{ invite.invited_by_name || '工作区管理员' }} 邀请你以{{ invite.role === 'admin' ? '管理员' : '成员' }}身份加入</p></div>
      <div class="inbox-actions"><el-button :disabled="!!busy" @click="respond(invite, false)">拒绝</el-button><el-button type="primary" :loading="busy === invite.id" :disabled="!!busy && busy !== invite.id" @click="respond(invite, true)">接受并进入</el-button></div>
    </div>
  </section>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { organizationAPI } from '@/api/organization'
import authApi from '@/api/auth'
import { saveAuthSession } from '@/utils/auth'

const invitations = ref([])
const loading = ref(false)
const busy = ref(null)
const error = ref('')
let timer
let disposed = false
let version = 0
async function refresh() {
  const requestVersion = ++version
  loading.value = true
  try {
    const result = await organizationAPI.receivedInvitations()
    if (!disposed && requestVersion === version) { invitations.value = result; error.value = '' }
  } catch (_) { if (!disposed && requestVersion === version) error.value = '邀请加载失败，请点击刷新重试' }
  finally { if (!disposed && requestVersion === version) loading.value = false }
}
async function respond(invite, accept) {
  if (busy.value) return
  busy.value = invite.id
  try {
    const result = await organizationAPI.respondInvitation(invite.id, accept)
    version++
    invitations.value = invitations.value.filter(item => item.id !== invite.id)
    window.dispatchEvent(new Event('workspace-invitations-changed'))
    if (accept) {
      ElMessage.success('已加入工作区')
      try {
        const session = await authApi.switchOrganization(result.organization.id)
        saveAuthSession(session.session, session.user)
        window.location.assign('/')
      } catch (_) { ElMessage.warning('已加入，请在账号菜单中切换工作区') }
    } else { ElMessage.success('已拒绝邀请') }
  } catch (_) { await refresh() }
  finally { busy.value = null; loading.value = false }
}
onMounted(() => {
  refresh()
  timer = window.setInterval(() => { if (!document.hidden && !busy.value) refresh() }, 30000)
})
onUnmounted(() => { disposed = true; window.clearInterval(timer) })
</script>

<style scoped>
.inbox{background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:22px;margin-bottom:18px;scroll-margin-top:24px}.inbox-heading{display:flex;align-items:center;justify-content:space-between}.inbox h2{margin:0;font-size:21px}.inbox p{color:#71717a;font-size:13px;line-height:1.6}.inbox-row{display:flex;gap:16px;align-items:center;justify-content:space-between;border-top:1px solid #eee;padding-top:16px;margin-top:16px}.inbox-row strong{overflow-wrap:anywhere}.inbox-actions{display:flex;flex-shrink:0}@media(max-width:700px){.inbox-row{align-items:flex-start;flex-direction:column}}
</style>
