<template>
  <el-dialog v-model="visible" title="批量下载视频" width="640px" style="max-width:94vw" @open="onOpen">
    <el-form label-width="90px">
      <el-form-item label="下载范围">
        <el-radio-group v-model="scope">
          <el-radio value="episode" :disabled="!episodeId">当前集</el-radio>
          <el-radio value="all">全部集</el-radio>
        </el-radio-group>
      </el-form-item>
      <el-form-item label="视频版本">
        <el-radio-group v-model="mode">
          <el-radio value="selected">选中主视频</el-radio>
          <el-radio value="all">全部历史版本</el-radio>
        </el-radio-group>
      </el-form-item>
    </el-form>
    <p class="download-hint">主视频优先使用你选中的版本；未选择时使用最新成功版本。全部历史版本包含每镜所有未删除的成功版本。</p>
    <p class="download-hint">仅下载已回传并保存到本地的视频，按集数、镜头顺序命名。尚未回传或文件缺失的视频会跳过，并写入 ZIP 中的下载清单。</p>
    <div v-loading="loading" style="min-height:80px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
      <template v-else-if="plan">
        <el-alert :title="`可下载 ${plan.count} 个视频，约 ${formatSize(plan.total_bytes)}；跳过 ${plan.skipped.length} 项`" :type="plan.count ? 'success' : 'warning'" :closable="false" show-icon />
        <el-collapse style="margin-top:12px">
          <el-collapse-item v-if="plan.files.length" title="查看视频文件列表" name="files">
            <div class="download-file-list"><div v-for="file in plan.files" :key="file.name">{{ file.name }}</div></div>
          </el-collapse-item>
          <el-collapse-item v-if="plan.skipped.length" title="查看跳过原因" name="skipped">
            <div class="download-file-list"><div v-for="(item, index) in plan.skipped" :key="index">{{ item.shot }}：{{ item.reason }}</div></div>
          </el-collapse-item>
        </el-collapse>
      </template>
    </div>
    <template #footer>
      <el-button @click="visible = false">关闭</el-button>
      <el-button :disabled="loading" @click="refreshPlan">刷新清单</el-button>
      <el-button type="primary" :loading="downloading" :disabled="loading || !plan?.count" @click="download">下载 ZIP（{{ plan?.count || 0 }} 个视频）</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'

const props = defineProps({ modelValue: Boolean, dramaId: [Number, String], episodeId: [Number, String], selectedVideoIds: Object })
const emit = defineEmits(['update:modelValue'])
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })
const scope = ref('episode')
const mode = ref('selected')
const loading = ref(false)
const downloading = ref(false)
const error = ref('')
const plan = ref(null)
let revision = 0
let preparedAt = 0

function formatSize(bytes) {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function onOpen() {
  if (!props.episodeId && scope.value === 'episode') scope.value = 'all'
  else refreshPlan()
}

async function refreshPlan() {
  const current = ++revision
  loading.value = true
  plan.value = null
  error.value = ''
  try {
    const result = await request.post(`/dramas/${props.dramaId}/video-downloads`, {
      scope: scope.value, mode: mode.value, episode_id: props.episodeId,
      selected_video_ids: mode.value === 'selected' ? props.selectedVideoIds : {},
    })
    if (current === revision) {
      plan.value = result
      preparedAt = Date.now()
    }
  } catch (e) {
    if (current === revision) error.value = e.message || '无法读取视频清单'
  } finally {
    if (current === revision) loading.value = false
  }
}

async function download() {
  if (!plan.value?.count || downloading.value) return
  if (Date.now() - preparedAt > 25 * 60 * 1000) {
    await refreshPlan()
    ElMessage.info('已更新下载清单，请确认后再次点击下载')
    return
  }
  downloading.value = true
  // Native download keeps large ZIPs out of the browser's JS heap.
  const a = document.createElement('a')
  a.href = plan.value.download_url
  a.download = plan.value.filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  ElMessage.success('已开始下载，请在浏览器下载列表查看进度')
  visible.value = false
  downloading.value = false
}

watch([scope, mode, () => props.dramaId, () => props.episodeId], () => {
  if (visible.value) refreshPlan()
})
</script>

<style scoped>
.download-hint { color: var(--el-text-color-secondary); font-size: 13px; line-height: 1.7; }
.download-file-list { max-height: 220px; overflow: auto; overflow-wrap: anywhere; line-height: 1.8; }
</style>
