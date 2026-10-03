<template>
  <div class="org-page">
    <header class="org-header">
      <div>
        <button class="back-button" @click="router.push('/')">← 返回项目</button>
        <p class="eyebrow">WORKSPACE ADMINISTRATION</p>
        <h1>{{ currentUser?.organization?.name || '工作区管理' }}</h1>
        <p class="subtitle">管理成员、角色和工作区访问权限。</p>
      </div>
      <div class="org-header-actions"><AccountMenu :key="currentUser?.organization?.id" /><div class="org-badge">{{ roleLabel(currentUser?.role) }}</div></div>
    </header>

    <main class="org-main">
      <section class="org-summary">
        <div><span class="summary-label">成员</span><strong>{{ members.length }}</strong></div>
        <div><span class="summary-label">待处理邀请</span><strong>{{ pendingInvitations }}</strong></div>
        <div><span class="summary-label">当前账号</span><strong>{{ currentUser?.display_name || currentUser?.email }}</strong></div>
      </section>

      <section class="panel workspace-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">YOUR WORKSPACES</p><h2>我的工作区</h2></div>
        </div>
        <div class="workspace-create">
          <el-input v-model="workspaceName" maxlength="80" placeholder="输入新工作区名称" @keyup.enter="createWorkspace" />
          <el-button type="primary" :loading="workspaceBusy" @click="createWorkspace">创建工作区</el-button>
        </div>
        <div class="workspace-list">
          <div v-for="workspace in workspaces" :key="workspace.id" class="workspace-row">
            <div class="workspace-info">
              <strong>{{ workspace.name }}</strong>
              <span>{{ roleLabel(workspace.role) }}<template v-if="workspace.id === currentUser?.organization?.id"> · 当前工作区</template></span>
            </div>
            <el-button v-if="workspace.role === 'owner'" text type="danger" :disabled="workspaces.length <= 1 || workspaceBusy" @click="deleteWorkspace(workspace)">删除</el-button>
          </div>
        </div>
        <p class="helper-text">删除工作区会同时删除其中的项目、生成记录、配置和素材文件；账号至少保留一个工作区。</p>
      </section>

      <section v-if="canManage" class="panel invite-panel">
        <div class="panel-heading">
          <div><p class="eyebrow">INVITE PEOPLE</p><h2>邀请成员加入工作区</h2></div>
          <span class="panel-note">站内邀请长期有效，接受后加入</span>
        </div>
        <div class="invite-form">
          <el-input v-model="inviteForm.email" placeholder="成员邮箱，例如 name@example.com" clearable @keyup.enter="sendInvite" />
          <el-select v-model="inviteForm.role" style="width: 140px">
            <el-option label="普通成员" value="member" />
            <el-option v-if="isOwner" label="管理员" value="admin" />
          </el-select>
          <el-input v-model="inviteForm.recipient_user_id" placeholder="对方的账号 ID" aria-label="对方的账号 ID" style="max-width:180px" />
          <el-button type="primary" :loading="inviting" @click="sendInvite">发送邀请</el-button>
        </div>
        <p class="helper-text">邀请直接显示在对方账号的“收到的邀请”中。请让对方先注册，并从账号菜单提供账号 ID；核对 ID 和邮箱后发送。邮箱仅作为账号名称，不代表已验证归属。</p>
      </section>

      <InvitationInbox />

      <section class="panel">
        <div class="panel-heading">
          <div><p class="eyebrow">MEMBERS</p><h2>工作区成员</h2></div>
          <el-button text :loading="loading" @click="loadAll">刷新</el-button>
        </div>
        <el-table v-loading="loading" :data="members" stripe>
          <el-table-column label="成员" min-width="250">
            <template #default="{ row }">
              <div class="member-cell"><strong>{{ row.display_name || row.email }}</strong><span>{{ row.email }}</span></div>
            </template>
          </el-table-column>
          <el-table-column label="角色" width="180">
            <template #default="{ row }">
              <el-select v-if="isOwner && row.role !== 'owner'" :model-value="row.role" size="small" @change="changeRole(row, $event)">
                <el-option label="普通成员" value="member" />
                <el-option label="管理员" value="admin" />
                <el-option label="所有者" value="owner" />
              </el-select>
              <el-tag v-else :type="row.role === 'owner' ? 'warning' : row.role === 'admin' ? 'success' : 'info'">{{ roleLabel(row.role) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="加入时间" width="190">
            <template #default="{ row }">{{ formatDate(row.joined_at) }}</template>
          </el-table-column>
          <el-table-column v-if="canManage" label="操作" width="120" align="right">
            <template #default="{ row }">
              <el-button v-if="row.role !== 'owner' && row.user_id !== currentUser?.id && (isOwner || row.role === 'member')" text type="danger" @click="remove(row)">移除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-if="canManage" class="panel">
        <div class="panel-heading"><div><p class="eyebrow">INVITATIONS</p><h2>邀请记录</h2></div></div>
        <el-table :data="invitations" stripe>
          <el-table-column prop="email" label="邮箱" min-width="240" />
          <el-table-column label="角色" width="120"><template #default="{ row }">{{ roleLabel(row.role) }}</template></el-table-column>
          <el-table-column label="状态" width="120"><template #default="{ row }"><el-tag :type="inviteTag(row.status)">{{ inviteStatus(row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="发送时间" width="190"><template #default="{ row }">{{ formatDate(row.created_at) }}</template></el-table-column>
          <el-table-column label="操作" width="230" align="right">
            <template #default="{ row }">
              <el-button v-if="row.status === 'needs_confirmation'" text @click="inviteForm.email = row.email; inviteForm.role = row.role; inviteForm.recipient_user_id = ''">核对账号后重发</el-button>
              <template v-if="row.status === 'pending'">
                <el-button v-if="isOwner || row.role === 'member'" text :disabled="inviting" @click="regenerateInvite(row)">重新发送</el-button>
                <el-button text type="danger" @click="revoke(row)">撤销</el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </section>

      <section v-if="canManage" class="panel">
        <div class="panel-heading">
          <div><p class="eyebrow">AUDIT TRAIL</p><h2>审计日志</h2></div>
          <el-button text :loading="auditLoading" @click="loadAuditLogs">刷新</el-button>
        </div>
        <el-table v-loading="auditLoading" :data="auditLogs" stripe>
          <el-table-column label="操作" min-width="240">
            <template #default="{ row }"><strong>{{ actionLabel(row.action) }}</strong><span v-if="row.metadata?.email" class="audit-meta">{{ row.metadata.email }}</span></template>
          </el-table-column>
          <el-table-column label="操作者" width="210"><template #default="{ row }">{{ row.actor_name || row.actor_email || '系统' }}</template></el-table-column>
          <el-table-column label="时间" width="200"><template #default="{ row }">{{ formatDate(row.created_at) }}</template></el-table-column>
        </el-table>
        <div v-if="!auditLoading && auditLogs.length === 0" class="empty-audit">暂无审计记录</div>
      </section>
    </main>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRouter } from 'vue-router'
import { organizationAPI } from '@/api/organization'
import authApi from '@/api/auth'
import { getAuthUser, saveAuthSession } from '@/utils/auth'
import AccountMenu from '@/components/AccountMenu.vue'
import InvitationInbox from '@/components/InvitationInbox.vue'

const router = useRouter()
const currentUser = ref(getAuthUser())
const members = ref([])
const workspaces = ref([])
const workspaceName = ref('')
const workspaceBusy = ref(false)
const invitations = ref([])
const loading = ref(false)
const inviting = ref(false)
const auditLogs = ref([])
const auditLoading = ref(false)
const inviteForm = reactive({ email: '', recipient_user_id: '', role: 'member' })
const isOwner = computed(() => currentUser.value?.role === 'owner')
const canManage = computed(() => ['owner', 'admin'].includes(currentUser.value?.role))
const pendingInvitations = computed(() => invitations.value.filter((item) => item.status === 'pending').length)

function roleLabel(role) { return role === 'owner' ? '所有者' : role === 'admin' ? '管理员' : '普通成员' }
function actionLabel(action) {
  const labels = {
    'announcement.published': '发布公告',
    'announcement.updated': '编辑公告',
    'announcement.withdrawn': '撤下公告',
    'auth.registered': '创建账号',
    'auth.logged_in': '登录工作区',
    'auth.logged_out': '退出登录',
    'auth.organization_switched': '切换工作区',
    'organization.invitation_created': '创建成员邀请',
    'organization.invitation_accepted': '接受成员邀请',
    'organization.member_role_changed': '修改成员角色',
    'organization.member_removed': '移除成员',
    'organization.invitation_revoked': '撤销成员邀请',
    'organization.invitation_declined': '拒绝成员邀请',
  }
  return labels[action] || action
}
function inviteStatus(status) { return status === 'needs_confirmation' ? '需重新确认' : status === 'pending' ? '待接受' : status === 'accepted' ? '已接受' : status === 'declined' ? '已拒绝' : '已撤销' }
function inviteTag(status) { return status === 'pending' ? 'warning' : status === 'accepted' ? 'success' : 'info' }
function formatDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '—' }

async function loadAll() {
  loading.value = true
  try {
    workspaces.value = await authApi.organizations()
    invitations.value = []
    auditLogs.value = []
    members.value = await organizationAPI.members()
    if (canManage.value) invitations.value = await organizationAPI.invitations()
    if (canManage.value) await loadAuditLogs()
  } finally { loading.value = false }
}
async function createWorkspace() {
  const name = workspaceName.value.trim()
  if (!name) return ElMessage.warning('请输入工作区名称')
  if (workspaceBusy.value) return
  workspaceBusy.value = true
  try {
    const created = await organizationAPI.createWorkspace(name)
    const session = await authApi.switchOrganization(created.id)
    saveAuthSession(session.session, session.user)
    workspaceName.value = ''
    window.location.reload()
  } finally { workspaceBusy.value = false }
}
async function deleteWorkspace(workspace) {
  if (workspaceBusy.value) return
  try {
    await ElMessageBox.confirm(
      `确定删除工作区“${workspace.name}”吗？其中的项目、生成记录、AI 配置和素材文件都会永久删除。`,
      '删除工作区',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning', distinguishCancelAndClose: true }
    )
  } catch (_) { return }
  workspaceBusy.value = true
  try {
    const result = await organizationAPI.deleteWorkspace(workspace.id)
    if (result.session && result.user) {
      saveAuthSession(result.session, result.user)
      window.location.reload()
      return
    }
    workspaces.value = await authApi.organizations()
    ElMessage.success('工作区已删除')
  } finally { workspaceBusy.value = false }
}
async function loadAuditLogs() {
  auditLoading.value = true
  try { auditLogs.value = (await organizationAPI.auditLogs({ page: 1, page_size: 50 })).items || [] }
  finally { auditLoading.value = false }
}
async function sendInvite() {
  if (inviting.value) return
  if (!inviteForm.email.trim()) return ElMessage.warning('请输入成员邮箱')
  inviting.value = true
  try {
    await organizationAPI.invite({ email: inviteForm.email.trim(), role: inviteForm.role, recipient_user_id: Number(inviteForm.recipient_user_id) })
    inviteForm.email = ''; inviteForm.recipient_user_id = ''
    await loadAll()
    ElMessage.success('站内邀请已发送，对方登录后即可处理')
  } finally { inviting.value = false }
}
async function regenerateInvite(row) {
  if (inviting.value) return
  inviting.value = true
  try {
    await organizationAPI.invite({ email: row.email, role: row.role, recipient_user_id: row.recipient_user_id })
    await loadAll()
    ElMessage.success('邀请已重新发送，旧邀请已失效')
  } finally { inviting.value = false }
}
async function changeRole(row, role) {
  try { row.role = (await organizationAPI.updateRole(row.user_id, role)).role; ElMessage.success('角色已更新') }
  catch (_) { await loadAll() }
}
async function remove(row) {
  await ElMessageBox.confirm('移除后该成员将无法访问工作区，确定继续吗？', '移除成员', { type: 'warning' })
  await organizationAPI.removeMember(row.user_id)
  members.value = members.value.filter((item) => item.user_id !== row.user_id)
  await loadAuditLogs()
  ElMessage.success('成员已移除')
}
async function revoke(row) {
  await organizationAPI.revokeInvitation(row.id)
  row.status = 'revoked'
  ElMessage.success('邀请已撤销')
}
onMounted(loadAll)
</script>

<style scoped>
.workspace-create{display:flex;gap:10px;margin-bottom:10px}.workspace-create .el-input{max-width:420px}.workspace-list{border-top:1px solid #eee}.workspace-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:58px;border-bottom:1px solid #f0f0f1}.workspace-info{display:flex;flex-direction:column;gap:4px;min-width:0}.workspace-info strong{font-size:14px;overflow-wrap:anywhere}.workspace-info span{color:#71717a;font-size:12px}
.org-page{min-height:100vh;background:#f7f7f8;color:#18181b}.org-header{display:flex;justify-content:space-between;align-items:flex-end;padding:42px max(28px,8vw) 36px;background:#141217;color:#fff}.back-button{border:0;background:transparent;color:#c4b5fd;padding:0;margin-bottom:30px;cursor:pointer;font-size:13px}.eyebrow{margin:0 0 10px;color:#a78bfa;letter-spacing:.18em;font-size:11px;font-weight:700}.org-header h1{margin:0;font-size:36px;letter-spacing:-.04em}.subtitle{margin:10px 0 0;color:#a1a1aa}.org-badge{padding:8px 14px;border:1px solid #6d5a91;border-radius:999px;color:#ddd6fe;text-transform:uppercase;font-size:11px;letter-spacing:.12em}.org-main{max-width:1180px;margin:auto;padding:28px}.org-summary{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:18px}.org-summary>div,.panel{border:1px solid #e4e4e7;background:#fff;border-radius:14px}.org-summary>div{padding:18px 20px}.summary-label{display:block;color:#71717a;font-size:12px;margin-bottom:8px}.org-summary strong{font-size:22px}.panel{padding:22px;margin-bottom:18px}.panel-heading{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:18px}.panel h2{margin:0;font-size:21px;letter-spacing:-.03em}.panel-note{color:#a1a1aa;font-size:12px}.invite-form{display:flex;gap:10px}.invite-form .el-input{flex:1}.invite-result{display:flex;align-items:center;gap:12px;margin-top:14px;padding:12px;background:#faf5ff;border:1px solid #e9d5ff;border-radius:9px;color:#6b21a8;font-size:12px}.invite-result code{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.member-cell{display:flex;flex-direction:column;gap:4px}.member-cell span{color:#71717a;font-size:12px}.org-page :deep(.el-table){--el-table-header-bg-color:#fafafa}.org-page :deep(.el-table__inner-wrapper:before){display:none}@media(max-width:700px){.org-header{display:block;padding:28px 20px}.org-header h1{font-size:29px}.org-badge{display:inline-block;margin-top:20px}.org-main{padding:16px}.org-summary{grid-template-columns:1fr}.invite-form{display:grid;grid-template-columns:1fr}.invite-form .el-select{width:100%!important}.invite-result{display:block}.invite-result code{display:block;margin:8px 0}}
.helper-text{margin:12px 0 0;color:#71717a;font-size:12px}
.audit-meta{display:block;color:#71717a;font-size:12px;font-weight:400;margin-top:4px}.empty-audit{padding:20px;color:#a1a1aa;text-align:center;font-size:13px}
.org-header-actions{display:flex;align-items:center;gap:12px}
.invitation-code{display:block;overflow-wrap:anywhere;user-select:all;font-size:12px;line-height:1.6}.code-validity{display:block;color:#71717a;font-size:12px;margin-top:5px}
</style>
