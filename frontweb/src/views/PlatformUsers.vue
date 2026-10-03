<template>
  <section class="platform-users">
    <header class="users-heading">
      <div>
        <h2>用户列表</h2>
        <p>管理平台管理员权限。平台管理员可以进入管理平台并发布公告。</p>
      </div>
      <el-input
        v-model="query"
        clearable
        placeholder="搜索邮箱、名称或用户 ID"
        class="user-search"
        @keyup.enter="search"
        @clear="search"
      >
        <template #append>
          <el-button aria-label="搜索用户" @click="search">
            <el-icon><Search /></el-icon>
          </el-button>
        </template>
      </el-input>
    </header>

    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <el-table v-loading="loading" :data="users" row-key="id" style="width: 100%">
      <el-table-column prop="id" label="用户 ID" width="92" />
      <el-table-column label="用户" min-width="210">
        <template #default="{ row }">
          <div class="user-identity">
            <strong>{{ row.display_name || '未设置名称' }}</strong>
            <span>{{ row.email }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="账号状态" width="105">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 'active' ? 'success' : 'info'">
            {{ row.status === 'active' ? '正常' : '已停用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="workspace_count" label="工作区" width="90" />
      <el-table-column label="平台管理员" width="150">
        <template #default="{ row }">
          <el-tooltip v-if="row.admin_source === 'environment'" content="超级管理员由启动配置指定，需修改管理员名单才能撤销" placement="top">
            <span class="configured-admin"><el-tag size="small" type="warning">超级管理员</el-tag></span>
          </el-tooltip>
          <el-switch
            v-else
            :model-value="row.is_platform_admin"
            :loading="busyUserId === row.id"
            :disabled="row.status !== 'active'"
            :aria-label="`${row.display_name || row.email} 平台管理员权限`"
            @change="value => setAdmin(row, value)"
          />
        </template>
      </el-table-column>
      <el-table-column label="注册时间" min-width="165">
        <template #default="{ row }">{{ formatDate(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="205" fixed="right">
        <template #default="{ row }">
          <el-button size="small" :disabled="busyUserId !== null" @click="editDisplayName(row)">编辑名称</el-button>
          <el-tooltip v-if="row.is_platform_admin" content="请先撤销平台管理员权限" placement="top">
            <span><el-button size="small" type="danger" plain disabled>删除账号</el-button></span>
          </el-tooltip>
          <el-button
            v-else
            size="small"
            type="danger"
            plain
            :loading="busyUserId === row.id"
            :disabled="busyUserId !== null"
            @click="deleteUser(row)"
          >删除账号</el-button>
        </template>
      </el-table-column>
    </el-table>

    <div class="users-footer">
      <span>共 {{ total }} 个账号</span>
      <el-pagination
        v-if="total > pageSize"
        v-model:current-page="page"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        @current-change="loadUsers"
      />
    </div>
  </section>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Search } from '@element-plus/icons-vue'
import { platformUsersAPI } from '@/api/platformUsers'

const users = ref([])
const query = ref('')
const page = ref(1)
const pageSize = 20
const total = ref(0)
const loading = ref(false)
const loadError = ref('')
const busyUserId = ref(null)

function formatDate(value) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—'
}

async function loadUsers() {
  loading.value = true
  loadError.value = ''
  try {
    const result = await platformUsersAPI.list({ page: page.value, page_size: pageSize, q: query.value.trim() })
    users.value = result.items || []
    total.value = Number(result.total || 0)
  } catch (error) {
    loadError.value = error.message || '用户列表加载失败'
  } finally {
    loading.value = false
  }
}

function search() {
  page.value = 1
  loadUsers()
}

async function setAdmin(user, enabled) {
  if (busyUserId.value !== null) return
  if (!enabled) {
    try {
      await ElMessageBox.confirm(`确定撤销 ${user.email} 的平台管理员权限吗？`, '撤销管理员', {
        confirmButtonText: '确认撤销',
        cancelButtonText: '取消',
        type: 'warning',
      })
    } catch (_) {
      return
    }
  }

  busyUserId.value = user.id
  try {
    const result = await platformUsersAPI.setAdmin(user.id, enabled)
    user.is_platform_admin = result.is_platform_admin
    user.admin_source = result.admin_source
    ElMessage.success(enabled ? '已设置为平台管理员' : '已撤销平台管理员权限')
  } catch (_) {
    await loadUsers()
  } finally {
    busyUserId.value = null
  }
}

async function editDisplayName(user) {
  if (busyUserId.value !== null) return
  let displayName
  try {
    const result = await ElMessageBox.prompt('请输入用户名称（最多 80 个字符）', '编辑用户名称', {
      confirmButtonText: '保存',
      cancelButtonText: '取消',
      inputValue: user.display_name || '',
      inputMaxlength: 80,
      inputValidator: value => String(value || '').trim().length > 0 || '用户名称不能为空',
    })
    displayName = result.value.trim()
  } catch (_) { return }
  busyUserId.value = user.id
  try {
    const result = await platformUsersAPI.update(user.id, displayName)
    user.display_name = result.user.display_name
    ElMessage.success('用户名称已更新')
  } catch (_) {
    await loadUsers()
  } finally {
    busyUserId.value = null
  }
}

async function deleteUser(user) {
  if (busyUserId.value !== null) return
  try {
    await ElMessageBox.confirm(
      `确定删除账号 ${user.email} 及其创建的 ${user.created_workspace_count || 0} 个工作区吗？这些工作区中的项目、生成记录、配置和素材将一并删除，其他成员也会失去访问。该账号在其他工作区中的成员身份会移除。`,
      '删除账号',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning', distinguishCancelAndClose: true }
    )
  } catch (_) {
    return
  }

  busyUserId.value = user.id
  try {
    await platformUsersAPI.delete(user.id)
    ElMessage.success('账号已删除')
    if (users.value.length === 1 && page.value > 1) page.value -= 1
    await loadUsers()
  } catch (_) {
    // Shared request handling displays the server error.
  } finally {
    busyUserId.value = null
  }
}

onMounted(loadUsers)
</script>

<style scoped>
.platform-users{min-width:0;color:var(--el-text-color-primary)}
.users-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:18px}
.users-heading h2{margin:0 0 6px;font-size:18px}
.users-heading p{margin:0;color:var(--el-text-color-secondary);font-size:13px;line-height:1.5}
.user-search{width:min(360px,45%)}
.user-identity{display:flex;flex-direction:column;gap:4px;min-width:0}
.user-identity strong{font-size:13px;font-weight:600;overflow-wrap:anywhere}
.user-identity span{font-size:12px;color:var(--el-text-color-secondary);overflow-wrap:anywhere}
.configured-admin{display:inline-flex}
.users-footer{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px;color:var(--el-text-color-secondary);font-size:12px}
@media(max-width:700px){.users-heading{align-items:stretch;flex-direction:column}.user-search{width:100%}.users-footer{align-items:flex-start;flex-direction:column}}
</style>
