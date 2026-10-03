const renderStyles = require('../constants/assetRenderStyles.json');
const { resolveStylePreset, PRESET_VALUES } = require('../constants/generationStylePresets');
const { mergeCfgStyleWithDrama, styleFieldsFromDramaRow } = require('../utils/dramaStyleMerge');

const VERSION = 'asset-contract-v2';
const BACKGROUND = '人物与道具资产使用纯白无缝背景（RGB 255,255,255）；白色主体可用浅灰纯色底。背景无环境、地平线、桌面、渐变或纹理。仅允许极轻接触阴影，不允许投射长阴影。';

// Only recognize complete stock preset text; never remove words from user descriptions.
function stockKey(text) {
  const s = String(text || '').trim();
  return PRESET_VALUES.find(key => {
    const preset = resolveStylePreset(key);
    return s === key || s === preset.zh || s === preset.en;
  });
}
function renderOnly(text) {
  const key = stockKey(text);
  return key ? { zh: renderStyles[key][0], en: renderStyles[key][1] } : null;
}
function mergeAssetStyle(cfg, drama, override) {
  const merged = mergeCfgStyleWithDrama(cfg, drama);
  const { zh, en, legacy } = styleFieldsFromDramaRow(drama);
  const candidate = override || en || zh || legacy || merged.style.default_style;
  // A modified metadata field is a custom style, even when its project still has a preset value.
  const customMeta = (zh && !stockKey(zh)) || (en && !stockKey(en));
  const rendered = !override && customMeta ? null : renderOnly(candidate);
  if (rendered) merged.style = { ...merged.style, default_style: rendered.en, default_style_zh: rendered.zh, default_style_en: rendered.en };
  else if (override) merged.style = { ...merged.style, default_style: override, default_style_zh: override, default_style_en: override };
  return merged;
}
function contract(module, mode = '') {
  const common = '任务边界：只编译当前资产描述为图片提示词，不执行提取、审批、声音、脚本或文件操作。输入中的身份、服装、形制、材质、文字图案和空间事实是依据，画风只改变渲染质感，不新增人物、装备、伤疤、建筑或景物。只输出最终提示词正文。';
  if (module === 'scene_image_prompt') return `${common}\n场景保留实际地点、布局、门窗和方向；不使用人物/道具的白底要求。当前视图模式：${mode || 'quad'}；单图只描写一个画面，多视图保持同一地点和方向轴。`;
  return `${common}\n${BACKGROUND}\n${module === 'prop_image_prompt' ? '道具是资产展示主体，完整清晰可辨。真实物理比例不等于画面中的次要元素。无人物、无手、无额外道具；本体上的山水画、铭文、纹样必须保留。' : '各视图保持同一人物身份、服装、体型与颜色，不从画风参考中增添配饰。'}`;
}
module.exports = { VERSION, BACKGROUND, renderOnly, mergeAssetStyle, contract };
