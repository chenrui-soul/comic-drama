<template>
  <el-alert v-if="info" :type="info.state === 'stale' || info.last_attempt?.status === 'failed' ? 'warning' : 'info'" :closable="false" show-icon style="margin-bottom:12px">
    <div>当前规则：{{ info.selected_pack_name }} {{ info.selected_pack_version ? `v${info.selected_pack_version}` : '' }}</div>
    <div>提示词状态：{{ labels[info.state] || info.state }}<span v-if="info.source === 'skill'"> · 编译版本 v{{ info.pack_version }}</span></div>
    <div v-if="info.state === 'stale' || (info.state === 'legacy' && info.selected_pack_id)">请重新生成提示词后生图；原文会保留在版本记录中。</div>
    <div v-if="info.last_attempt?.status === 'failed'">上次编译失败：{{ info.last_attempt.error }}</div>
  </el-alert>
  <el-button v-if="assetId && type" size="small" @click="showHistory">提示词版本记录</el-button>
  <el-dialog v-model="historyOpen" title="提示词版本记录" width="800px" append-to-body>
    <p>历史原文保留。需要恢复时，可复制到编辑框作为人工版本保存。</p>
    <el-select v-if="type === 'scene'" v-model="historyMode" @change="loadHistory"><el-option label="四宫格" value="quad" /><el-option label="单图" value="single" /></el-select>
    <p v-if="!history.length">暂无编译记录，当前历史提示词会在首次重新编译时归档。</p>
    <details v-for="item in history" :key="item.id" style="margin:12px 0">
      <summary>{{ item.created_at }} · {{ item.source }} {{ item.pack_version ? `v${item.pack_version}` : '' }} · {{ item.status }}</summary>
      <p v-if="item.error">{{ item.error }}</p>
      <el-input v-if="item.prompt" :model-value="item.prompt" type="textarea" :rows="8" readonly />
    </details>
  </el-dialog>
</template>
<script setup>
import { ref } from 'vue'
import request from '@/utils/request'
const props=defineProps({ info: { type: Object, default: null }, type: String, assetId: [String,Number] })
const historyOpen=ref(false),history=ref([]),historyMode=ref('quad')
async function loadHistory() {
  const id=props.assetId
  const rows=await request.get(`/asset-prompts/${props.type}/${id}/history`,{params:{mode:props.type==='prop'?'single':historyMode.value}})
  if(id===props.assetId) history.value=rows||[]
}
function showHistory() { historyOpen.value=true;loadHistory() }
const labels = { ready: '已按当前规则编译', stale: '描述或规则已更新，提示词待更新', legacy: '历史提示词，来源未记录', manual: '人工编辑，保留原文', empty: '待编译', missing: '资产不存在' }
</script>
