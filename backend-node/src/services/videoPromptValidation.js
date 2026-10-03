const SECTIONS = ['段级视觉风格', '本段剧情范围与唯一核心结果', '参考资产绑定', '空间、轴线与光影基准', '0.0秒初始状态', '时间轴', '目标时长最终状态', '下一段续接状态', '连续性硬约束', '禁止项'];
const DIMENSIONS = ['构图与摄影机', '路线、道具与物理过程', '人物表演与身体反馈', '对白、口型与声音', '光影、特效与环境反馈'];
const intervalPattern = () => /[\[【]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)?\s*[-–—~～至]\s*(\d+(?:\.\d+)?)\s*(?:秒|s)\s*[|｜][^\]\】]*[\]】]/g;

// Only apply this contract when the selected skill explicitly declares it.
function declaresPreparationStructure(pack) {
  const source = (pack?.files || []).filter(f => pack.active_paths?.includes(f.path)).map(f => f.content).join('\n');
  return SECTIONS.every(s => source.includes(`【${s}】`)) && DIMENSIONS.every(s => source.includes(s));
}

function validateSkillStructure(text, pack) {
  if (!declaresPreparationStructure(pack)) return [];
  const issues = [];
  const positions = SECTIONS.map(s => text.indexOf(`【${s}】`));
  let last = -1;
  for (let i = 0; i < SECTIONS.length; i++) {
    const pos = positions[i];
    if (pos < 0) { issues.push(`缺少【${SECTIONS[i]}】`); continue; }
    if (pos <= last) issues.push(`【${SECTIONS[i]}】顺序不符合所选 Skill`);
    last = pos;
    const next = positions.slice(i + 1).find(p => p > pos) ?? text.length;
    if (!text.slice(pos + SECTIONS[i].length + 2, next).replace(/[\s*#\-]/g, '')) issues.push(`【${SECTIONS[i]}】内容为空`);
  }
  const timeline = positions[5] >= 0 ? text.slice(positions[5], positions[6] > positions[5] ? positions[6] : undefined) : '';
  const beats = [...timeline.matchAll(intervalPattern())];
  if (!beats.length) issues.push('【时间轴】内缺少镜头/节拍区间');
  beats.forEach((beat, index) => {
    const body = timeline.slice(beat.index + beat[0].length, beats[index + 1]?.index ?? timeline.length);
    for (const dimension of DIMENSIONS) {
      const label = new RegExp(dimension + '\\s*[：:]\\s*(.+)');
      if (!label.test(body)) issues.push(`时间轴第 ${index + 1} 段缺少「${dimension}」具体内容`);
    }
  });
  return issues;
}
module.exports = { validateSkillStructure, declaresPreparationStructure, SECTIONS, DIMENSIONS };
