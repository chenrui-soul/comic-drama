<template>
  <el-button size="small" :disabled="!asset?.id" @click="open = true">完整视图包</el-button>
  <el-dialog v-model="open" title="完整资产视图包" width="760px" append-to-body>
    <p>当前编辑内容将用于编译。视图结果独立保存，不替换已有资产主图。</p>
    <p v-if="type === 'scene'">默认输出正、反、左、右一张四宫格；需要时可额外生成顶俯图。</p>
    <el-checkbox v-if="type === 'scene'" v-model="includeTop">额外生成独立顶俯图</el-checkbox>
    <el-input v-if="type === 'scene'" v-model="axis" placeholder="明确正面方向，例如：面向北墙入口为正面" />
    <el-select v-if="history.length" :model-value="bundle?.id" placeholder="查看历史版本" @change="selectHistory">
      <el-option v-for="item in history" :key="item.id" :value="item.id" :label="`${item.created_at.slice(0,19)} · ${item.id.slice(0,8)}`" />
    </el-select>
    <el-button style="margin:12px 0" :loading="busy" @click="compile">编译新视图包</el-button>
    <p v-if="bundle">来源：{{ bundle.payload.source === 'skill' ? `Skill v${bundle.payload.pack_version}` : '内置规则' }} · 版本 {{ bundle.id.slice(0, 8) }}</p>
    <div v-for="part in bundle?.payload.parts || []" :key="part.key" style="margin-bottom:18px">
      <strong>{{ part.file_name }}</strong>
      <p>{{ part.status }} {{ part.error_msg || '' }}</p>
      <el-input :model-value="part.prompt" type="textarea" :rows="3" readonly />
      <el-image v-if="part.local_path || part.image_url" :src="part.local_path ? `/static/${part.local_path}` : part.image_url" style="max-width:100%;max-height:240px" fit="contain" />
      <el-button v-if="['draft','failed'].includes(part.status)" :loading="busy" @click="generate(part)">{{ part.status === 'failed' ? '仅重试此视图' : '生成此视图' }}</el-button>
      <a v-if="part.local_path" :href="`/static/${part.local_path}`" :download="part.file_name">下载 {{ part.file_name }}</a>
      <el-button v-if="part.status === 'completed'" size="small" :loading="busy" @click="useReference(part)">用作当前参考图</el-button>
    </div>
  </el-dialog>
</template>
<script setup>
import { ref, watch, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import request from '@/utils/request'
const props = defineProps({ type: { type: String, required: true }, asset: { type: Object, default: null } })
const emit = defineEmits(['reference-changed'])
const open = ref(false), busy = ref(false), axis = ref(''), bundle = ref(null), history = ref([]), includeTop = ref(false)
let timer, sequence = 0
async function useReference(part) {
  busy.value=true
  try {
    await request.post(`/asset-view-bundles/${bundle.value.id}/parts/${part.key}/use-reference`,{})
    emit('reference-changed',{type:props.type,id:props.asset.id,image_url:part.image_url,local_path:part.local_path})
    ElMessage.success('已更新参考图并保留原主图；已提交视频继续使用原快照')
  } finally {busy.value=false}
}
function selectHistory(id) { bundle.value = history.value.find(item => item.id === id) || null }
async function loadHistory() {
  const token = ++sequence, id = props.asset?.id
  if (!id) return
  const items = await request.get(`/asset-views/${props.type}/${id}`)
  if (token !== sequence || id !== props.asset?.id) return
  history.value = items || []
  bundle.value = history.value.find(item => item.id === bundle.value?.id) || history.value[0] || null
}
async function compile() {
  if (props.type === 'scene' && !axis.value.trim()) return ElMessage.warning('请先指定正面方向')
  busy.value = true
  const id = props.asset.id
  try {
    const result = await request.post(`/asset-views/${props.type}/${id}`, { front_axis: axis.value, include_top: includeTop.value, input: props.asset, input_revision: props.asset.prompt_status?.input_revision })
    if (id !== props.asset?.id) return
    bundle.value = result
    await loadHistory()
  }
  finally { busy.value = false }
}
async function refresh() {
  const id = bundle.value?.id
  if (!id) return
  const result = await request.get(`/asset-view-bundles/${id}`)
  if (id === bundle.value?.id) bundle.value = result
}
async function generate(part) {
  busy.value = true
  try { bundle.value = await request.post(`/asset-view-bundles/${bundle.value.id}/parts/${part.key}`, {}) }
  finally { busy.value = false }
}
watch(open, value => { clearInterval(timer); if (value) { loadHistory(); timer = setInterval(() => refresh().catch(() => {}), 3000) } })
watch(() => props.asset?.id, () => { sequence++; bundle.value = null; history.value = []; axis.value = ''; includeTop.value = false; if (open.value) loadHistory() })
onUnmounted(() => clearInterval(timer))
</script>
