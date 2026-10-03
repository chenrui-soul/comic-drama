<template>
  <div class="rule-skill-manager">
    <div class="manager-hero">
      <div>
        <div class="eyebrow">RULES &amp; SKILLS</div>
        <h2>提示词与 Skill</h2>
        <p>集中管理提示词覆盖、故事剧本 Skill、资产 Skill 和视频提示词 Skill。导入与编辑都会生成新版本，不会覆盖平台内置规则。</p>
      </div>
      <el-button type="primary" :loading="busy" @click="triggerImport">
        <el-icon><Upload /></el-icon>
        导入规则包
      </el-button>
      <input ref="importRef" type="file" accept=".zip,.json,.md" hidden @change="onImport" />
    </div>

    <el-alert v-if="!dramaId" type="info" :closable="false" show-icon class="scope-alert">
      当前为全局配置。打开具体项目后，可在这里绑定该项目使用的故事、资产和视频规则。
    </el-alert>

    <el-tabs v-model="activeSection" class="rule-tabs">
      <el-tab-pane label="内置提示词" name="prompts">
        <div class="section-intro"><strong>内置提示词覆盖</strong><span>适合微调自动润色、全能模式和各阶段的 System Prompt。</span></div>
        <PromptEditor />
      </el-tab-pane>

      <el-tab-pane label="故事剧本 Skill" name="story">
        <div class="section-intro"><strong>故事 / 剧本生成</strong><span>控制故事梗概到故事、剧本的生成流程。</span></div>
        <div v-if="dramaId" class="binding-grid single-binding">
          <div class="binding-card">
            <div class="binding-label">当前项目故事规则</div>
            <div class="binding-value">{{ creativeSettings.story_name || '平台内置故事规则' }}<small v-if="creativeSettings.story_version">v{{ creativeSettings.story_version }}</small></div>
            <el-select v-model="creativeSettings.story_pack_id" clearable placeholder="使用平台内置规则" @change="saveCreativeSettings">
              <el-option v-for="pack in storyPacks" :key="pack.id" :label="`${pack.name} v${pack.version}`" :value="pack.id" />
            </el-select>
          </div>
        </div>
        <div class="pack-grid">
          <article v-for="pack in storyPacks" :key="pack.id" class="pack-card">
            <div class="pack-heading"><div><div class="pack-kind">故事剧本</div><h3>{{ pack.name }}</h3></div><el-tag size="small" :type="isCreativeSelected(pack) ? 'success' : 'info'">v{{ pack.version }}</el-tag></div>
            <p>{{ pack.source || '平台内置规则包' }}</p><div class="file-list">{{ (pack.active_paths || []).slice(0, 4).join(' · ') || 'SKILL.md' }}</div>
            <SkillCompatibility :report="pack.compatibility" />
            <div class="pack-actions"><el-button size="small" type="primary" plain :disabled="!dramaId || !!pack.compatibility?.errors?.length" @click="selectCreative(pack)">{{ isCreativeSelected(pack) ? '当前项目已用' : '用于本项目' }}</el-button><el-button size="small" @click="editPack(pack, 'creative')">编辑</el-button><a :href="creativeSkillRulesAPI.exportUrl(pack.id)" download>导出</a></div>
          </article>
          <div v-if="!storyPacks.length" class="empty-card">还没有故事剧本 Skill，可导入 ZIP、JSON 或 SKILL.md。</div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="资产 Skill" name="asset">
        <div class="section-intro"><strong>人物 / 场景 / 道具资产</strong><span>控制人物图、场景图、宫格图、多视图图和道具图提示词。</span></div>
        <div v-if="dramaId" class="binding-grid single-binding">
          <div class="binding-card">
            <div class="binding-label">当前项目资产规则</div>
            <div class="binding-value">{{ creativeSettings.asset_name || '平台内置资产规则' }}<small v-if="creativeSettings.asset_version">v{{ creativeSettings.asset_version }}</small></div>
            <el-select v-model="creativeSettings.asset_pack_id" clearable placeholder="使用平台内置规则" @change="saveCreativeSettings">
              <el-option v-for="pack in assetPacks" :key="pack.id" :label="`${pack.name} v${pack.version}`" :value="pack.id" />
            </el-select>
          </div>
        </div>
        <div class="pack-grid">
          <article v-for="pack in assetPacks" :key="pack.id" class="pack-card">
            <div class="pack-heading"><div><div class="pack-kind">人物 / 场景 / 道具</div><h3>{{ pack.name }}</h3></div><el-tag size="small" :type="isCreativeSelected(pack) ? 'success' : 'info'">v{{ pack.version }}</el-tag></div>
            <p>{{ pack.source || '平台内置规则包' }}</p><div class="file-list">{{ (pack.active_paths || []).slice(0, 4).join(' · ') || 'SKILL.md' }}</div>
            <SkillCompatibility :report="pack.compatibility" />
            <div class="pack-actions"><el-button size="small" type="primary" plain :disabled="!dramaId || !!pack.compatibility?.errors?.length" @click="selectCreative(pack)">{{ isCreativeSelected(pack) ? '当前项目已用' : '用于本项目' }}</el-button><el-button size="small" @click="editPack(pack, 'creative')">编辑</el-button><a :href="creativeSkillRulesAPI.exportUrl(pack.id)" download>导出</a></div>
          </article>
          <div v-if="!assetPacks.length" class="empty-card">还没有资产 Skill，可导入 ZIP、JSON 或 SKILL.md。</div>
        </div>
      </el-tab-pane>

      <el-tab-pane label="视频提示词 Skill" name="video">
        <div class="section-intro"><strong>视频提示词生成</strong><span>控制分镜提示词编译、自动润色和项目风格追加；视频生成接口与分镜数据结构保持不变。</span></div>
        <div v-if="dramaId" class="video-settings">
          <div class="binding-card video-binding"><div><div class="binding-label">当前项目规则</div><div class="binding-value">{{ videoSettings.name || '平台内置视频规则' }}<small v-if="videoSettings.version">v{{ videoSettings.version }}</small></div></div><el-select v-model="videoSettings.pack_id" clearable placeholder="使用平台内置规则" @change="saveVideoSettings"><el-option v-for="pack in videoPacks" :key="pack.id" :label="`${pack.name} v${pack.version}`" :value="pack.id" /></el-select></div>
          <div class="switch-card"><el-switch v-model="videoSettings.auto_polish" @change="saveVideoSettings" /><div><strong>自动润色</strong><p>按当前视频 Skill 优化分镜提示词</p></div></div>
          <div class="switch-card"><el-switch v-model="videoSettings.append_style" @change="saveVideoSettings" /><div><strong>追加项目风格</strong><p>提交视频前附加项目风格描述</p></div></div>
        </div>
        <div class="pack-grid">
          <article v-for="pack in videoPacks" :key="pack.id" class="pack-card" :class="{ selected: videoSettings.pack_id === pack.id }">
            <div class="pack-heading"><div><div class="pack-kind">视频提示词</div><h3>{{ pack.name }}</h3></div><el-tag size="small" :type="videoSettings.pack_id === pack.id ? 'success' : 'info'">v{{ pack.version }}</el-tag></div>
            <p>{{ pack.source || '平台内置规则包' }}</p><div class="file-list">{{ (pack.active_paths || []).slice(0, 4).join(' · ') || 'SKILL.md' }}</div>
            <div class="pack-actions"><el-button size="small" type="primary" plain :disabled="!dramaId" @click="selectVideo(pack)">{{ videoSettings.pack_id === pack.id ? '当前项目已用' : '用于本项目' }}</el-button><el-button size="small" @click="editPack(pack, 'video')">编辑</el-button><a :href="videoPromptRulesAPI.exportUrl(pack.id)" download>导出</a></div>
          </article>
          <div v-if="!videoPacks.length" class="empty-card">还没有视频规则包，可导入 ZIP、JSON 或 SKILL.md。</div>
        </div>
      </el-tab-pane>
    </el-tabs>

    <el-dialog v-model="editor.open" title="编辑 Skill（保存为新版本）" width="min(900px, 92vw)" destroy-on-close>
      <p class="editor-hint">可选择包内文本文件编辑。保存创建新版本；只有勾选下方选项才切换当前项目，已有提示词不会自动重写。</p>
      <el-select v-model="editor.path" style="width:100%;margin-bottom:12px"><el-option v-for="file in editor.files" :key="file.path" :label="file.path" :value="file.path" /></el-select>
      <el-input v-if="editor.files.some(f => f.path === editor.path)" v-model="editor.files.find(f => f.path === editor.path).content" type="textarea" :rows="22" placeholder="请输入 Skill 规则" />
      <el-checkbox v-if="dramaId" v-model="editor.apply">保存后用于当前项目（其他项目保持原绑定）</el-checkbox>
      <template #footer><el-button @click="editor.open = false">取消</el-button><el-button type="primary" :loading="busy" @click="saveEdited">保存新版本</el-button></template>
    </el-dialog>
    <el-dialog v-model="importDialog.open" title="导入规则包" width="440px">
      <p class="editor-hint">先选择规则类型，再选择 ZIP、JSON 或 SKILL.md。导入会新增版本，不会覆盖原规则。</p>
      <el-radio-group v-model="importDialog.kind" class="import-kind-group">
        <el-radio-button label="story">故事 / 剧本</el-radio-button>
        <el-radio-button label="asset">人物 / 场景 / 道具</el-radio-button>
        <el-radio-button label="video">视频提示词</el-radio-button>
      </el-radio-group>
      <template #footer><el-button @click="importDialog.open = false">取消</el-button><el-button type="primary" @click="chooseImportFile">选择文件</el-button></template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Upload } from '@element-plus/icons-vue'
import PromptEditor from '@/components/PromptEditor.vue'
import SkillCompatibility from '@/components/SkillCompatibility.vue'
import { videoPromptRulesAPI } from '@/api/videoPromptRules'
import { creativeSkillRulesAPI } from '@/api/creativeSkillRules'

const props = defineProps({ dramaId: { type: [Number, String], default: null } })
const activeSection = ref('prompts')
const importRef = ref(null)
const busy = ref(false)
const importDialog = ref({ open: false, kind: 'video' })
const videoPacks = ref([])
const creativePacks = ref([])
const videoSettings = ref({ pack_id: null, name: '平台内置视频规则', version: '', auto_polish: true, append_style: true })
const creativeSettings = ref({ story_pack_id: null, asset_pack_id: null, story_name: '平台内置故事规则', asset_name: '平台内置资产规则' })
const editor = ref({ open: false, pack: null, kind: '', files: [], path: '', apply: false })
const storyPacks = computed(() => creativePacks.value.filter((p) => p.kind === 'story'))
const assetPacks = computed(() => creativePacks.value.filter((p) => p.kind === 'asset'))

let loadSequence = 0
async function load() {
  const sequence = ++loadSequence, dramaId = props.dramaId
  try {
    const [video, creative] = await Promise.all([videoPromptRulesAPI.list(), creativeSkillRulesAPI.list()])
    if (sequence !== loadSequence) return
    videoPacks.value = video?.packs || []
    creativePacks.value = creative?.packs || []
    if (dramaId) {
      const [videoProject, creativeProject] = await Promise.all([videoPromptRulesAPI.getProject(dramaId), creativeSkillRulesAPI.getProject(dramaId)])
      if (sequence !== loadSequence) return
      videoSettings.value = { ...videoSettings.value, ...videoProject }
      creativeSettings.value = { ...creativeSettings.value, ...creativeProject }
    } else {
      videoSettings.value = { pack_id: null, auto_polish: true, append_style: true }
      creativeSettings.value = { story_pack_id: null, asset_pack_id: null }
    }
  } catch (_) {
    ElMessage.error('提示词与 Skill 加载失败')
  }
}

function triggerImport() { importDialog.value.open = true }
function chooseImportFile() { importDialog.value.open = false; importRef.value?.click() }
async function onImport(event) {
  const file = event.target.files?.[0]
  if (!file) return
  busy.value = true
  try {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    const encoded = btoa(binary)
    const isCreative = importDialog.value.kind !== 'video'
    const out = isCreative
      ? await creativeSkillRulesAPI.importBase64(file.name, encoded, importDialog.value.kind)
      : await videoPromptRulesAPI.importBase64(file.name, encoded)
    ElMessage.success(`已导入 ${out?.pack?.name || file.name} v${out?.pack?.version || ''}`)
    await load()
  } catch (e) { ElMessage.error(e?.message || '导入失败') } finally { busy.value = false; event.target.value = '' }
}

function isCreativeSelected(pack) { return pack.kind === 'story' ? creativeSettings.value.story_pack_id === pack.id : creativeSettings.value.asset_pack_id === pack.id }
async function saveCreativeSettings() {
  if (!props.dramaId) return
  creativeSettings.value = await creativeSkillRulesAPI.setProject(props.dramaId, { story_pack_id: creativeSettings.value.story_pack_id, asset_pack_id: creativeSettings.value.asset_pack_id })
  ElMessage.success('创作 Skill 配置已保存')
}
async function selectCreative(pack) { if (!props.dramaId) return ElMessage.warning('请从具体项目打开 AI 配置'); if (pack.kind === 'story') creativeSettings.value.story_pack_id = pack.id; else creativeSettings.value.asset_pack_id = pack.id; await saveCreativeSettings() }
async function saveVideoSettings() {
  if (!props.dramaId) return
  videoSettings.value = await videoPromptRulesAPI.setProject(props.dramaId, { pack_id: videoSettings.value.pack_id, auto_polish: !!videoSettings.value.auto_polish, append_style: !!videoSettings.value.append_style })
  ElMessage.success('视频 Skill 配置已保存')
}
async function selectVideo(pack) { if (!props.dramaId) return ElMessage.warning('请从具体项目打开 AI 配置'); videoSettings.value.pack_id = pack.id; await saveVideoSettings() }
function editPack(pack, kind) { const files = (pack.files || []).map(f => ({ ...f })); const skill = files.find(f => /(^|\/)SKILL\.md$/i.test(f.path)); editor.value = { open: true, pack, kind, files, path: skill?.path || files[0]?.path, apply: false } }
async function saveEdited() {
  if (!editor.value.files.find(f => /(^|\/)SKILL\.md$/i.test(f.path))?.content.trim()) return ElMessage.warning('SKILL.md 不能为空')
  busy.value = true
  try {
    const p = editor.value.pack
    const files = editor.value.files.map(f => ({ path: f.path, content: f.content }))
    const api = editor.value.kind === 'creative' ? creativeSkillRulesAPI : videoPromptRulesAPI
    const out = await api.importFiles({ name: p.name, version: `${p.version.split('-custom')[0]}-custom${Date.now()}`, kind: p.kind, files, source: `基于 ${p.name} v${p.version} 编辑` })
    if (editor.value.apply && props.dramaId && out?.pack) {
      if (editor.value.kind === 'creative') await selectCreative(out.pack)
      else await selectVideo(out.pack)
    }
    editor.value.open = false
    ElMessage.success(editor.value.apply ? '新版本已保存并绑定当前项目；已有提示词需重新编译才使用新规则' : '新版本已保存，项目仍使用原绑定；可点击“用于本项目”切换')
    await load()
  } catch (e) { ElMessage.error(e?.message || '保存失败') } finally { busy.value = false }
}
watch(() => props.dramaId, load)
onMounted(load)
</script>

<style scoped>
.rule-skill-manager{--purple:#6d45e8;--purple-soft:#f3efff;color:#27243b}.manager-hero{display:flex;align-items:flex-end;gap:24px;justify-content:space-between;padding:4px 0 20px}.eyebrow{font-size:11px;letter-spacing:.16em;color:var(--purple);font-weight:700}.manager-hero h2{margin:6px 0 8px;font-size:24px}.manager-hero p{margin:0;max-width:720px;color:#746f87;line-height:1.65;font-size:13px}.scope-alert{margin-bottom:16px}.rule-tabs :deep(.el-tabs__header){margin-bottom:0}.rule-tabs :deep(.el-tabs__item){font-weight:600}.section-intro{display:flex;gap:12px;align-items:baseline;padding:18px 0 14px;color:#777189;font-size:13px}.section-intro strong{font-size:16px;color:#302b48}.binding-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-bottom:16px}.binding-card,.switch-card{border:1px solid #e6e0f3;background:linear-gradient(145deg,#fff,#faf8ff);border-radius:12px;padding:16px}.binding-label,.pack-kind{font-size:11px;color:#8469c8;font-weight:700;letter-spacing:.06em}.binding-value{font-size:15px;font-weight:600;margin:8px 0 12px;color:#38314d}.binding-value small{margin-left:6px;color:#9b8cb7;font-weight:400}.binding-card .el-select{width:100%}.pack-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.pack-card{border:1px solid #e6e0f3;background:#fff;border-radius:12px;padding:16px;transition:.2s}.pack-card.selected,.pack-card:hover{border-color:#b8a5f3;box-shadow:0 6px 18px rgba(109,69,232,.1)}.pack-heading{display:flex;justify-content:space-between;gap:12px}.pack-card h3{margin:5px 0 8px;font-size:16px;color:#302b48}.pack-card p{min-height:38px;color:#827b93;font-size:12px;line-height:1.55;margin:0}.file-list{min-height:34px;margin:12px 0;color:#8d74c5;font:11px/1.5 ui-monospace,Consolas,monospace;word-break:break-word}.pack-actions{display:flex;gap:10px;align-items:center}.pack-actions a{font-size:12px;color:#6d45e8;text-decoration:none}.video-settings{display:grid;grid-template-columns:1.4fr repeat(2,1fr);gap:12px;margin-bottom:16px}.video-binding{display:flex;align-items:center;justify-content:space-between;gap:14px}.video-binding .el-select{max-width:210px}.switch-card{display:flex;align-items:center;gap:12px}.switch-card strong{font-size:13px}.switch-card p{margin:4px 0 0;color:#91899e;font-size:11px}.empty-card{padding:32px;border:1px dashed #cfc4ea;border-radius:12px;color:#9289a5;text-align:center}.editor-hint{color:#817890;font-size:13px}.import-kind-group{display:flex;flex-wrap:wrap;gap:8px}.import-kind-group :deep(.el-radio-button__inner){border-radius:7px!important;border-left:1px solid var(--el-border-color)!important}.rule-skill-manager :deep(.prompt-editor-page){min-height:420px}.rule-skill-manager :deep(.editor-layout){min-height:420px;height:calc(100vh - 390px)}@media(max-width:850px){.manager-hero,.video-settings{display:block}.manager-hero .el-button{margin-top:14px}.binding-grid{grid-template-columns:1fr}.video-settings>*{margin-bottom:12px}.video-binding{display:block}.video-binding .el-select{max-width:none;margin-top:10px}}
:global(html:not(.light)) .rule-skill-manager{color:#eeeaf8}.rule-skill-manager :deep(.prompt-editor-page){background:transparent}:global(html:not(.light)) .rule-skill-manager .section-intro strong,:global(html:not(.light)) .rule-skill-manager .binding-value,:global(html:not(.light)) .rule-skill-manager .pack-card h3{color:#eeeaf8}:global(html:not(.light)) .rule-skill-manager .manager-hero p,:global(html:not(.light)) .rule-skill-manager .section-intro,:global(html:not(.light)) .rule-skill-manager .pack-card p{color:#aaa3bc}:global(html:not(.light)) .rule-skill-manager .binding-card,:global(html:not(.light)) .rule-skill-manager .switch-card,:global(html:not(.light)) .rule-skill-manager .pack-card{background:#201d2a;border-color:#403752}:global(html:not(.light)) .rule-skill-manager .empty-card{border-color:#5a4e73;color:#aaa3bc}
</style>
