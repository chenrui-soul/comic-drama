<template>
  <el-button size="small" :disabled="!episodeId" @click="show">单元规划报告</el-button>
  <el-dialog v-model="open" title="单元规划与时长" width="850px" append-to-body>
    <el-button size="small" :loading="loading" @click="load">刷新报告</el-button>
    <p v-if="!record">暂无长段规划记录。20 / 25 / 30 秒容量生成分镜后可在此查看。</p>
    <template v-else>
      <p>状态：{{ statusLabel }} · {{ record.created_at }}</p>
      <el-alert v-if="record.error" :title="record.error" type="warning" :closable="false" />
      <p class="settings-summary">{{ settingsSummary(plan?.settings) }}</p>
      <p v-if="plan?.settings?.style" class="settings-summary">风格：{{ plan.settings.style }}</p>
      <p v-if="plan?.phase">阶段：{{ phaseLabel }} · 自动修正 {{ plan.repair_count || 0 }}/2 轮</p>
      <p>单元按本次设置规划；自然剧情与请求时长分别记录，不为凑时长新增剧情。未通过的草稿不会覆盖原分镜。</p>
      <ul v-if="plan?.issues?.length" class="issues"><li v-for="(problem, i) in plan.issues" :key="i">{{ problem.message }}</li></ul>
      <el-collapse v-if="plan?.corrections?.length"><el-collapse-item title="查看已自动修正的估时与关联"><ul><li v-for="(correction, i) in plan.corrections" :key="i">{{ correction.message }}</li></ul></el-collapse-item></el-collapse>
      <el-table :data="Array.isArray(plan?.units) ? plan.units : []">
        <el-table-column label="单元" width="65"><template #default="{ row, $index }">{{ row.index || $index + 1 }}</template></el-table-column>
        <el-table-column prop="main_arc" label="主叙事弧" />
        <el-table-column label="上限" width="85"><template #default="{ row }">{{ secondsLabel(row.capacity_ms) }}</template></el-table-column>
        <el-table-column label="关键路径" width="95"><template #default="{ row }">{{ secondsLabel(row.estimated_story_ms) }}</template></el-table-column>
        <el-table-column label="请求" width="85"><template #default="{ row }">{{ secondsLabel(row.request_duration_ms) }}</template></el-table-column>
        <el-table-column label="闭合依据"><template #default="{ row }">{{ row.closure?.reason }}</template></el-table-column>
        <el-table-column type="expand"><template #default="{ row }"><pre class="state-details">{{ JSON.stringify({ 初始状态: row.initial_state, 结束状态: row.final_state, 事件: row.events, 时间轨: row.schedule }, null, 2) }}</pre></template></el-table-column>
      </el-table>
      <p>报告验证结构、原文覆盖和时长约束。对白表演、动作连贯性和画面质量仍需检查生成结果。</p>
    </template>
  </el-dialog>
</template>
<script setup>
import { ref, computed, watch } from 'vue'
import request from '@/utils/request'
import { secondsLabel, readPlan, settingsSummary } from '@/utils/narrativePlanReport'

const props = defineProps({ episodeId: { type: [Number, String], default: null } })
const open = ref(false)
const loading = ref(false)
const record = ref(null)
let sequence = 0
const plan = computed(() => readPlan(record.value?.payload))
const phaseLabel = computed(() => ({ settings: '检查设置', events: '整理原文事件', repair_events: '修正事件与计时', allocation: '分配视频单元', repair_allocation: '定向修正分段', closure_review: '核验叙事闭合', validated: '规划通过', blocked: '待处理' }[plan.value?.phase] || plan.value?.phase))
const statusLabel = computed(() => ({ planning: '规划中', validated: '结构校验通过', published: '已发布到分镜', blocked: '需要复核', superseded: '已有新版' }[record.value?.status] || record.value?.status))

async function load() {
  const token = ++sequence
  const id = props.episodeId
  if (!id) return
  loading.value = true
  try {
    const value = await request.get(`/episodes/${id}/narrative-plan`)
    if (token === sequence) record.value = value
  } finally {
    if (token === sequence) loading.value = false
  }
}

function show() { open.value = true; load() }
watch(() => props.episodeId, () => { sequence++; record.value = null; if (open.value) load() })
</script>
<style scoped>
.state-details { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 400px; overflow: auto; padding: 16px; }
.settings-summary { line-height: 1.7; overflow-wrap: anywhere; }
.issues { max-height: 220px; overflow: auto; line-height: 1.7; }
</style>
