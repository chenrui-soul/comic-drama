<template>
  <div class="episode-batch-import-trigger">
    <el-button size="small" @click="openDialog"><el-icon><Upload /></el-icon>批量导入剧集</el-button>
    <el-dialog v-model="visible" title="批量导入剧集 · 原文保留" width="min(960px, 94vw)" append-to-body destroy-on-close
      :close-on-click-modal="!importing" :close-on-press-escape="!importing" :show-close="!importing" @closed="resetState">
      <el-alert title="仅识别集标题和场次，原文完整保存。不会调用 AI，也不会改写对白、动作或调整剧情顺序。" type="info" :closable="false" show-icon />
      <el-tabs v-model="activeTab" class="import-tabs">
        <el-tab-pane label="1. 文件与格式检查" name="config" :disabled="importing">
          <div class="import-panel">
            <div class="import-dropzone" @dragover.prevent @drop.prevent="onFileDrop">
              <div class="import-toolbar">
                <input ref="fileInputRef" type="file" accept=".txt,.md" hidden @change="onFileChange" />
                <el-button :loading="picking || reading" @click="chooseFile"><el-icon><Upload /></el-icon>{{ picking ? '正在打开文件窗口…' : '选择 TXT / MD 文件' }}</el-button>
                <span>{{ fileName || '尚未选择文件' }}</span>
              </div>
              <p class="import-help">也可将 TXT / MD 文件直接拖到这里，无需打开文件窗口。</p>
            </div>
            <el-form label-width="120px">
              <el-form-item label="文件编码">
                <el-select v-model="encoding" aria-label="文件编码" @change="readSelectedFile">
                  <el-option label="自动（UTF-8 / UTF-16）" value="auto" />
                  <el-option label="GB18030（兼容 GBK）" value="gb18030" />
                  <el-option label="UTF-8" value="utf-8" />
                  <el-option label="UTF-16 LE" value="utf-16le" />
                  <el-option label="UTF-16 BE" value="utf-16be" />
                </el-select>
              </el-form-item>
              <el-form-item label="结构识别方式">
                <el-select v-model="mode" aria-label="结构识别方式">
                  <el-option label="自动识别集标题（推荐）" value="auto" />
                  <el-option label="整份文件作为一集" value="single" />
                  <el-option label="自定义章节匹配（高级）" value="custom" />
                </el-select>
              </el-form-item>
              <template v-if="mode === 'custom'">
                <el-form-item label="章节正则"><el-input v-model="chapterPattern" placeholder="按行匹配章节标题" /></el-form-item>
                <el-form-item label="每集章节数"><el-input-number v-model="groupSize" :min="1" :max="100" /></el-form-item>
              </template>
              <el-form-item label="目标集号">
                <el-select v-model="numbering" aria-label="目标集号">
                  <el-option :label="'顺序追加（从第 ' + startEpisodeNumber + ' 集开始）'" value="append" />
                  <el-option label="使用原文集号（已有集号将阻止导入）" value="source" />
                </el-select>
              </el-form-item>
            </el-form>
            <p class="import-help">支持“第八集”“## 第八集 亲子鉴定”等标题；“### 8-1”作为场次，“【字幕】”“【报告特写】”保留为正文。自动模式不会合并已识别的集。</p>
            <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
            <details v-if="rawText"><summary>查看解码后的原文 · {{ decodedEncoding }}</summary><pre class="script-preview">{{ rawText }}</pre></details>
          </div>
        </el-tab-pane>
        <el-tab-pane label="2. 原文核对与导入" name="preview" :disabled="!report">
          <div v-if="report" class="import-panel">
            <el-alert title="逐字符一致性校验通过 · 正文变化 0 字" type="success" :closable="false" show-icon />
            <dl class="import-stats">
              <div><dt>编码</dt><dd>{{ decodedEncoding }}</dd></div>
              <div><dt>分集 / 场次</dt><dd>{{ report.episodes.length }} 集 / {{ sceneCount }} 场</dd></div>
              <div><dt>原文字符数</dt><dd>{{ report.originalLength }}</dd></div>
              <div><dt>导入字符数</dt><dd>{{ report.importedLength }}</dd></div>
            </dl>
            <p class="import-help">字符统计包含标题、空格和换行。仅整理独立的集标题字段；保存的正文仍含原始标题、Markdown 标记和全部空行。</p>
            <el-alert v-for="warning in report.warnings" :key="warning" :title="warning" type="warning" :closable="false" show-icon />
            <el-alert v-if="numberError" :title="numberError" type="error" :closable="false" show-icon />
            <el-table :data="report.episodes" border max-height="320">
              <el-table-column label="目标集号" width="100"><template #default="{ $index, row }">{{ numbering === 'source' ? (row.source_number || '待确认') : startEpisodeNumber + $index }}</template></el-table-column>
              <el-table-column prop="title" label="集标题" min-width="200" />
              <el-table-column label="场次" width="80"><template #default="{ row }">{{ row.scenes.length }}</template></el-table-column>
              <el-table-column label="字符数" width="100"><template #default="{ row }">{{ row.script_content.length }}</template></el-table-column>
              <el-table-column label="核对正文" width="110"><template #default="{ $index }"><el-button link type="primary" @click="previewIndex = $index">查看全文</el-button></template></el-table-column>
            </el-table>
            <template v-if="report.episodes[previewIndex]">
              <h3>{{ report.episodes[previewIndex].title }} · 将保存的完整原文</h3>
              <p v-if="report.episodes[previewIndex].scenes.length" class="import-help">{{ report.episodes[previewIndex].scenes.join(' / ') }}</p>
              <pre class="script-preview" tabindex="0" aria-label="将保存的完整原文">{{ report.episodes[previewIndex].script_content }}</pre>
            </template>
            <el-checkbox v-model="confirmed" :disabled="importing">我已核对目标集号、分集边界和正文，按原文导入</el-checkbox>
            <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
          </div>
        </el-tab-pane>
      </el-tabs>
      <template #footer>
        <el-button :disabled="importing" @click="visible = false">取消</el-button>
        <el-button v-if="activeTab === 'preview'" :disabled="importing" @click="activeTab = 'config'">返回调整</el-button>
        <el-button v-if="activeTab === 'config'" type="primary" :disabled="!rawText || reading" @click="checkFormat">检查格式并预览</el-button>
        <el-button v-else type="primary" :disabled="!confirmed || !!numberError || !report" :loading="importing" @click="confirmImport">确认原文导入</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Upload } from '@element-plus/icons-vue'
import { decodeScriptFile, inspectScript, prepareImportRows } from '@/utils/scriptImport'

const props = defineProps({
  startEpisodeNumber: { type: Number, default: 1 },
  existingEpisodeNumbers: { type: Array, default: () => [] },
  importEpisodes: { type: Function, required: true },
})
const visible = ref(false), activeTab = ref('config'), importing = ref(false), reading = ref(false), picking = ref(false)
const fileInputRef = ref(null), fileName = ref(''), rawText = ref(''), selectedFile = ref(null)
const encoding = ref('auto'), decodedEncoding = ref(''), mode = ref('auto'), numbering = ref('append')
const chapterPattern = ref('^\\s*(第[0-9０-９零一二三四五六七八九十百千万]+[集章回节][^\\n\\r]*)')
const groupSize = ref(1), report = ref(null), error = ref(''), confirmed = ref(false), previewIndex = ref(0)
let readVersion = 0
const sceneCount = computed(() => report.value?.episodes.reduce((n, e) => n + e.scenes.length, 0) || 0)
function rows() {
  return prepareImportRows(report.value, { numbering: numbering.value, start: props.startEpisodeNumber, existingNumbers: props.existingEpisodeNumbers })
}
const numberError = computed(() => {
  if (!report.value) return ''
  try { rows(); return '' } catch (e) { return e.message }
})
function invalidate() { report.value = null; confirmed.value = false; error.value = ''; activeTab.value = 'config' }
watch([mode, chapterPattern, groupSize, numbering], invalidate)
watch(() => [props.startEpisodeNumber, ...props.existingEpisodeNumbers], () => { confirmed.value = false })
function openDialog() { visible.value = true; activeTab.value = 'config' }
defineExpose({ openDialog })
function resetState() {
  readVersion++
  selectedFile.value = null; fileName.value = ''; rawText.value = ''; decodedEncoding.value = ''
  encoding.value = 'auto'; mode.value = 'auto'; numbering.value = 'append'; groupSize.value = 1
  reading.value = false; previewIndex.value = 0; invalidate()
  if (fileInputRef.value) fileInputRef.value.value = ''
}
async function onFileChange(event) {
  const file = event.target?.files?.[0]
  // Selecting the same file again should still fire change (for example after editing it).
  if (event.target) event.target.value = ''
  await selectFile(file)
}
async function chooseFile() {
  if (picking.value || reading.value) return
  if (typeof window.showOpenFilePicker !== 'function') {
    fileInputRef.value?.click()
    return
  }
  picking.value = true
  const version = readVersion
  try {
    // A dedicated picker avoids inheriting unrelated uploads' last directories.
    // On first use, start in Documents instead of the system's recent-files view.
    const [handle] = await window.showOpenFilePicker({
      id: 'episode-script-import', startIn: 'documents', multiple: false,
      types: [{ description: '剧本文本（TXT / MD）', accept: { 'text/plain': ['.txt', '.md'] } }],
    })
    const file = await handle.getFile()
    if (visible.value && version === readVersion) await selectFile(file)
  } catch (e) {
    if (e.name !== 'AbortError' && visible.value && version === readVersion) {
      error.value = '无法打开文件窗口，请将 TXT / MD 文件直接拖入上方区域。'
    }
  } finally { picking.value = false }
}
async function onFileDrop(event) {
  if (importing.value || picking.value || reading.value) return
  const files = event.dataTransfer?.files
  if (!files?.length) return
  if (files.length !== 1) { error.value = '请一次选择一份 TXT / MD 文件。'; return }
  await selectFile(files[0])
}
async function selectFile(file) {
  if (!file) return
  if (!/\.(txt|md)$/i.test(file.name)) { error.value = '请选择 TXT 或 MD 文本文件。'; return }
  selectedFile.value = file; fileName.value = file.name
  await readSelectedFile()
}
async function readSelectedFile() {
  const version = ++readVersion
  invalidate(); rawText.value = ''; decodedEncoding.value = ''
  if (!selectedFile.value) return
  reading.value = true
  try {
    const buffer = await selectedFile.value.arrayBuffer()
    if (version !== readVersion) return
    const decoded = decodeScriptFile(buffer, encoding.value)
    rawText.value = decoded.text; decodedEncoding.value = decoded.encoding
  } catch (e) {
    if (version === readVersion) error.value = e.message || '读取文件失败'
  } finally { if (version === readVersion) reading.value = false }
}
function checkFormat() {
  try {
    report.value = inspectScript(rawText.value, { mode: mode.value, pattern: chapterPattern.value, groupSize: groupSize.value, fileName: fileName.value })
    previewIndex.value = 0; confirmed.value = false; error.value = ''; activeTab.value = 'preview'
  } catch (e) { report.value = null; error.value = e.message || '格式检查失败' }
}
async function confirmImport() {
  if (importing.value || !confirmed.value || !report.value || numberError.value) return
  importing.value = true; error.value = ''
  try {
    const payload = rows()
    if (payload.map(e => e.script_content).join('') !== rawText.value) throw new Error('原文一致性检查失败，已阻止导入。')
    await props.importEpisodes(payload)
    ElMessage.success('已按原文导入 ' + payload.length + ' 集，正文未改写')
    visible.value = false
  } catch (e) { error.value = e.message || '保存失败，原文预览已保留，可重试' }
  finally { importing.value = false }
}
</script>

<style scoped>
.episode-batch-import-trigger { display: inline-flex; }
.import-tabs { margin-top: 16px; }
.import-panel { display: flex; flex-direction: column; gap: 16px; }
.import-dropzone { display: flex; flex-direction: column; gap: 8px; padding: 14px; border: 1px dashed var(--el-border-color); border-radius: 8px; }
.import-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; overflow-wrap: anywhere; }
.import-help { margin: 0; color: var(--el-text-color-regular); line-height: 1.7; }
.import-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin: 0; padding: 16px; background: var(--el-fill-color-light); border-radius: 8px; }
.import-stats dt { color: var(--el-text-color-regular); font-size: 13px; }
.import-stats dd { margin: 8px 0 0; font-size: 16px; font-weight: 600; color: var(--el-text-color-primary); }
.script-preview { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; padding: 16px; margin: 8px 0 0; border: 1px solid var(--el-border-color); border-radius: 8px; background: var(--el-fill-color-light); color: var(--el-text-color-primary); font: inherit; line-height: 1.75; }
.import-panel h3 { font-size: 16px; margin: 0; }
.import-panel summary { cursor: pointer; padding: 8px 0; color: var(--el-text-color-primary); }
@media (max-width: 640px) { .import-stats { grid-template-columns: repeat(2, 1fr); } }
</style>
