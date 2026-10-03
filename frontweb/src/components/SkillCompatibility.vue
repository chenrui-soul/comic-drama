<template>
  <details v-if="report" class="skill-compatibility">
    <summary>查看支持范围与文件（{{ report.errors?.length ? '需修复' : '提示词编译模式' }}）</summary>
    <p v-for="error in report.errors || []" :key="error" class="error">{{ error }}</p>
    <p v-for="warning in report.warnings || []" :key="warning">{{ warning }}</p>
    <div v-for="(paths, module) in report.module_paths || {}" :key="module"><strong>{{ labels[module] || module }}</strong><p>{{ paths.join(' · ') }}</p></div>
    <p>仅归档：{{ (report.archived_paths || []).join(' · ') || '无' }}</p>
  </details>
</template>
<script setup>
defineProps({ report: { type: Object, default: null } })
const labels = { character_image_prompt: '人物提示词', scene_image_prompt: '场景提示词', prop_image_prompt: '道具提示词', story_generation: '故事剧本' }
</script>
<style scoped>
.skill-compatibility{font-size:12px;line-height:1.6;margin:12px 0;overflow-wrap:anywhere}.skill-compatibility p{margin:6px 0}.skill-compatibility summary{cursor:pointer}.error{color:var(--el-color-danger)}
</style>
