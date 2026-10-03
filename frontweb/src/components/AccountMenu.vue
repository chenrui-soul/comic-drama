<template>
  <el-popover v-model:visible="visible" placement="bottom-end" :width="300" trigger="click" :show-after="40" @show="loadOrganizations">
    <template #reference>
      <button class="account-trigger" type="button">
        <span class="account-avatar">{{ initials }}</span>
        <span class="account-copy"><b>{{ user?.display_name || user?.email || '账号' }}</b><small>{{ user?.organization?.name || '工作区' }}</small></span>
        <span class="account-chevron">⌄</span>
        <span v-if="invitationCount" class="invitation-badge" :aria-label="`${invitationCount} 条待处理邀请`">{{ invitationCount }}</span>
      </button>
    </template>
    <div class="account-popover">
      <div class="account-heading">
        <strong>{{ user?.display_name || user?.email }}</strong>
        <span>{{ user?.email }}</span>
        <span>账号 ID：{{ user?.id }}</span>
        <el-tag size="small" effect="plain">{{ roleLabel(user?.role) }}</el-tag>
      </div>
      <template v-if="user?.is_platform_admin">
        <div class="workspace-label">平台</div>
        <button class="workspace-option" type="button" @click="visible = false; router.push('/admin')">管理平台</button>
      </template>
      <div class="workspace-label">工作区</div>
      <button class="workspace-option" type="button" @click="goInvitations">收到的邀请 <b>{{ invitationCount }}</b></button>
      <button v-for="org in organizations" :key="org.id" class="workspace-option" :class="{ active: org.id === user?.organization?.id }" type="button" @click="switchWorkspace(org)">
        <span class="workspace-dot">{{ (org.name || '工').slice(0, 1) }}</span>
        <span><b>{{ org.name }}</b><small>{{ roleLabel(org.role) }}</small></span>
        <span v-if="org.id === user?.organization?.id" class="workspace-check">✓</span>
      </button>
      <div class="account-actions">
        <button type="button" @click="goOrganization">工作区管理 / 加入</button>
        <button type="button" class="logout-action" @click="logout">退出登录</button>
      </div>
    </div>
  </el-popover>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { useRouter } from 'vue-router'
import authApi from '@/api/auth'
import { organizationAPI } from '@/api/organization'
import { clearAuthSession, getAuthToken, getAuthUser, saveAuthSession } from '@/utils/auth'

const router = useRouter()
const visible = ref(false)
const user = ref(getAuthUser())
const organizations = ref([])
const invitationCount = ref(0)
let invitationTimer
let disposed = false
const initials = computed(() => String(user.value?.display_name || user.value?.email || '账').trim().slice(0, 1).toUpperCase())

function roleLabel(role) { return role === 'owner' ? '所有者' : role === 'admin' ? '管理员' : '成员' }
async function loadOrganizations() {
  user.value = getAuthUser()
  try {
    const { user: freshUser } = await authApi.me()
    if (!disposed) {
      user.value = freshUser
      saveAuthSession({ token: getAuthToken() }, freshUser)
    }
  } catch (_) {}
  loadInvitationCount()
  try { organizations.value = await authApi.organizations() } catch (_) {}
}
async function loadInvitationCount() {
  try {
    const list = await organizationAPI.receivedInvitations()
    if (!disposed) invitationCount.value = list.length
  } catch (_) {}
}
function goInvitations() {
  visible.value = false
  router.push('/organization#invitations')
}
async function switchWorkspace(org) {
  if (org.id === user.value?.organization?.id) return
  try {
    const session = await authApi.switchOrganization(org.id)
    saveAuthSession(session.session, session.user)
    user.value = session.user
    visible.value = false
    ElMessage.success(`已切换到${org.name}`)
    window.location.reload()
  } catch (_) {}
}
function goOrganization() {
  visible.value = false
  router.push('/organization')
}
async function logout() {
  try { await authApi.logout() } catch (_) {}
  clearAuthSession()
  visible.value = false
  router.replace({ name: 'login' })
}
onMounted(() => {
  loadOrganizations()
  window.addEventListener('workspace-invitations-changed', loadOrganizations)
  invitationTimer = window.setInterval(() => { if (!document.hidden) loadInvitationCount() }, 30000)
})
onUnmounted(() => {
  disposed = true
  window.clearInterval(invitationTimer)
  window.removeEventListener('workspace-invitations-changed', loadOrganizations)
})
</script>

<style scoped>
.invitation-badge{background:#dc2626;color:#fff;min-width:18px;border-radius:12px;padding:2px 5px;font-size:11px;text-align:center}
.account-trigger{display:flex;align-items:center;gap:9px;padding:5px 10px 5px 6px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.06);color:inherit;cursor:pointer;text-align:left}.account-trigger:hover{background:rgba(255,255,255,.12)}.account-avatar{display:grid;place-items:center;width:29px;height:29px;border-radius:50%;background:#8b5cf6;color:#fff;font-weight:700;font-size:13px}.account-copy{display:flex;flex-direction:column;min-width:82px;line-height:1.2}.account-copy b{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}.account-copy small{color:#a1a1aa;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px}.account-chevron{color:#a1a1aa;font-size:14px}.account-popover{color:#27243b}.account-heading{position:relative;padding:3px 4px 14px;border-bottom:1px solid #eee;display:flex;flex-direction:column;gap:4px}.account-heading span{color:#817b8b;font-size:12px}.account-heading .el-tag{position:absolute;right:0;top:0}.workspace-label{padding:14px 4px 7px;color:#9a92a7;font-size:11px;letter-spacing:.08em}.workspace-option{display:flex;align-items:center;width:100%;gap:9px;padding:9px 6px;border:0;border-radius:8px;background:transparent;color:#302b3d;text-align:left;cursor:pointer}.workspace-option:hover,.workspace-option.active{background:#f6f2ff}.workspace-dot{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#ede9fe;color:#6d45e8;font-weight:700;font-size:12px}.workspace-option>span:nth-child(2){display:flex;flex:1;flex-direction:column;gap:2px}.workspace-option small{color:#91899e;font-size:11px}.workspace-check{color:#6d45e8;font-weight:700}.account-actions{display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid #eee}.account-actions button{flex:1;padding:8px;border:0;border-radius:7px;background:#f5f3f7;color:#4c4458;cursor:pointer;font-size:12px}.account-actions button:hover{background:#ece7f5}.account-actions .logout-action{color:#b42318;background:#fff1f0}
</style>
