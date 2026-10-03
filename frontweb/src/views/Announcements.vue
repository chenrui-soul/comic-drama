<template>
  <main :class="['announcements-page', { embedded }]">
    <header v-if="!embedded" class="page-header">
      <div>
        <el-button text @click="router.push('/')">← 返回项目</el-button>
        <h1>平台公告</h1>
        <p>{{ canManage ? '向所有工作区成员发布通知' : '查看面向所有工作区成员的通知' }}</p>
      </div>
      <AccountMenu />
    </header>
    <div class="toolbar">
      <el-button v-if="canManage" type="primary" @click="openEditor()">发布公告</el-button>
      <el-switch v-if="canManage" v-model="manage" active-text="显示已撤下公告" @change="page = 1; load()" />
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>
    <el-alert v-if="loadError" :title="loadError" type="error" :closable="false" show-icon />
    <section v-loading="loading" aria-label="公告列表" class="notice-list">
      <el-empty v-if="!loading && !loadError && !items.length" description="暂无公告" />
      <article v-for="item in items" :key="item.id" class="notice">
        <div class="notice-heading">
          <h2>{{ item.title }}</h2>
          <el-tag v-if="item.status === 'withdrawn'" type="info">已撤下</el-tag>
        </div>
        <p class="notice-meta">{{ item.author_name || '管理员' }} · {{ formatDate(item.created_at) }} 发布<span v-if="item.updated_at !== item.created_at"> · {{ formatDate(item.updated_at) }} 更新</span></p>
        <p class="notice-body">{{ item.content }}</p>
        <div v-if="canManage" class="notice-actions">
          <el-button text @click="openEditor(item)">编辑</el-button>
          <el-button text :type="item.status === 'published' ? 'warning' : 'primary'" :disabled="busyId !== null" @click="changeStatus(item)">{{ item.status === 'published' ? '撤下' : '重新发布' }}</el-button>
        </div>
      </article>
    </section>
    <el-pagination v-if="total > 10" v-model:current-page="page" :page-size="10" :total="total" layout="prev, pager, next" @current-change="load" />
    <el-dialog v-model="editorVisible" :title="editingId ? '编辑公告' : '发布公告'" width="min(640px, 94vw)" :close-on-click-modal="false" :close-on-press-escape="!saving" :show-close="!saving">
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="公告标题" required>
          <el-input v-model="form.title" aria-label="公告标题" maxlength="120" show-word-limit :disabled="saving" />
        </el-form-item>
        <el-form-item label="公告正文" required>
          <el-input v-model="form.content" aria-label="公告正文" type="textarea" :rows="10" maxlength="10000" show-word-limit :disabled="saving" placeholder="填写通知内容，支持换行" />
        </el-form-item>
        <p class="notice-meta">{{ form.status === 'withdrawn' ? '保存后仍保持撤下状态，可在列表中重新发布。' : '发布后所有工作区成员均可查看。' }}</p>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!form.title.trim() || !form.content.trim()" @click="save">{{ editingId ? '保存修改' : '确认发布' }}</el-button>
      </template>
    </el-dialog>
  </main>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import AccountMenu from '@/components/AccountMenu.vue'
import { announcementsAPI } from '@/api/announcements'

const props = defineProps({ embedded: { type: Boolean, default: false }, readOnly: { type: Boolean, default: false } })
const router = useRouter()
// The API returns current permissions; stale local role data must not grant edit controls.
const canManage = ref(false)
const items = ref([]), total = ref(0), page = ref(1), manage = ref(false)
const loading = ref(false), loadError = ref(''), busyId = ref(null)
const editorVisible = ref(false), editingId = ref(null), saving = ref(false)
const form = reactive({ title: '', content: '', status: 'published' })
let loadVersion = 0
function formatDate(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
async function load() {
  const version = ++loadVersion
  loading.value = true
  loadError.value = ''
  try {
    const result = await announcementsAPI.list({ page: page.value, page_size: 10, manage: manage.value })
    if (version !== loadVersion) return
    canManage.value = !props.readOnly && result.can_manage
    items.value = result.items
    total.value = result.total
    // 管理侧只是维护公告，不应在发布后立即把自己的弹窗标记为已读。
    // 普通用户打开公告页时才按“查看即已读”处理。
    if (props.readOnly) {
      await Promise.allSettled(items.value.filter(item => item.status === 'published').map(item => announcementsAPI.markRead(item.id)))
    }
    if (!items.value.length && page.value > 1) { page.value = Math.max(1, Math.ceil(total.value / 10)); return load() }
  } catch (err) { if (version === loadVersion) loadError.value = err.message || '公告加载失败，请刷新重试' }
  finally { if (version === loadVersion) loading.value = false }
}
function openEditor(item) {
  editingId.value = item?.id || null
  Object.assign(form, { title: item?.title || '', content: item?.content || '', status: item?.status || 'published' })
  editorVisible.value = true
}
async function save() {
  if (saving.value || !form.title.trim() || !form.content.trim()) return
  saving.value = true
  try {
    if (editingId.value) await announcementsAPI.update(editingId.value, { ...form })
    else await announcementsAPI.create({ title: form.title, content: form.content })
    editorVisible.value = false
    ElMessage.success(editingId.value ? '公告已更新' : '公告已发布')
    page.value = 1
    await load()
  } catch (_) { /* The shared request handler displays the server error. */ }
  finally { saving.value = false }
}
async function changeStatus(item) {
  if (busyId.value !== null) return
  const status = item.status === 'published' ? 'withdrawn' : 'published'
  try {
    await ElMessageBox.confirm(status === 'withdrawn' ? '撤下后普通成员将无法查看，平台管理员可以重新发布。' : '重新发布后所有工作区成员均可查看。', status === 'withdrawn' ? '撤下公告' : '重新发布公告', { confirmButtonText: '确认', cancelButtonText: '取消' })
    busyId.value = item.id
    await announcementsAPI.update(item.id, { title: item.title, content: item.content, status })
    ElMessage.success(status === 'withdrawn' ? '公告已撤下' : '公告已发布')
    await load()
  } catch (_) { /* Cancel or shared request error. */ }
  finally { busyId.value = null }
}
onMounted(load)
</script>

<style scoped>
.announcements-page{max-width:960px;margin:0 auto;padding:32px 24px;color:var(--el-text-color-primary)}
.announcements-page.embedded{max-width:none;margin:0;padding:0}
.page-header{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:28px}
h1{font-size:28px;margin:12px 0}.page-header p,.notice-meta{color:var(--el-text-color-secondary);font-size:13px}
.toolbar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.notice-list{min-height:160px}.notice{border:1px solid var(--el-border-color-light);background:var(--el-bg-color);border-radius:12px;padding:24px;margin-bottom:16px}
.notice-heading{display:flex;align-items:center;gap:12px}.notice-heading h2{font-size:19px;margin:0;overflow-wrap:anywhere}
.notice-body{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;margin:20px 0}.notice-actions{display:flex;justify-content:flex-end;gap:8px}
@media(max-width:600px){.announcements-page{padding:20px 14px}.page-header{align-items:flex-start;flex-wrap:wrap}.notice{padding:18px}}
</style>
