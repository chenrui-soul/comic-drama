const crypto = require('crypto');
const compiler = require('./assetPromptCompiler');
const skills = require('./creativeSkillPacks');
const policy = require('./assetPromptPolicy');
const ai = require('./aiClient');
const image = require('./imageClient');
const { safeParseAIJSON } = require('../utils/safeJson');
const { getTenantId } = require('../utils/tenantContext');
function init(db) { db.exec(`CREATE TABLE IF NOT EXISTS asset_view_bundles (id TEXT PRIMARY KEY, asset_type TEXT NOT NULL, asset_id INTEGER NOT NULL, drama_id INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);`); }
function layouts(type, axis, includeTop = false) {
  if (type==='scene') {
    if(!String(axis||'').trim()) throw new Error('场景完整视图必须先指定正面方向，例如“面向北墙入口为正面”');
    return {...(includeTop ? {top90:`单张独立90度顶俯视图，正面方向轴：${axis}。保持完整空间几何，不能拼图。`} : {}),orthographic_4view:`同一空间的2×2正交四视图，左上正面、右上背面、左下左侧、右下右侧，各格只标注对应方向。正面方向轴：${axis}。四个视角保持相同门窗、固定家具、尺度与地标。不增加第五或空白第六格。${includeTop ? '与独立顶俯视图保持一致。' : '用户已选择仅正反左右四视图，不生成顶俯图。'}`};
  }
  if(type==='character') return {identity_4view:'2×2人物身份视图：左上面部特写、右上正面全身、左下侧面全身、右下背面全身。同一人物同一服装，纯白底，身体完整不裁切。'};
  if(type==='prop') return {prop_4view:'2×2道具多视图：左上正面、右上侧面、左下顶视、右下结构细节。同一道具，比例与材质一致，纯白底，完整清晰展示主体。'};
  throw new Error('不支持的资产类型');
}
function get(db,id) {
  init(db);
  const tenantId = getTenantId();
  const row = tenantId
    ? db.prepare('SELECT b.* FROM asset_view_bundles b JOIN dramas d ON d.id=b.drama_id WHERE b.id=? AND d.organization_id=? AND d.deleted_at IS NULL').get(id, tenantId)
    : db.prepare('SELECT * FROM asset_view_bundles WHERE id=?').get(id);
  if(!row)return null;
  const payload=JSON.parse(row.payload);
  for(const part of payload.parts) if(part.image_id) {
    const generated=db.prepare('SELECT status,image_url,local_path,error_msg,task_id FROM image_generations WHERE id=?').get(part.image_id);
    if(generated) Object.assign(part,generated);
  }
  return {...row,payload};
}
function list(db,type,id) {
  init(db);compiler.definition(type);
  const tenantId = getTenantId();
  const rows = tenantId
    ? db.prepare('SELECT b.id FROM asset_view_bundles b JOIN dramas d ON d.id=b.drama_id WHERE b.asset_type=? AND b.asset_id=? AND d.organization_id=? ORDER BY b.rowid DESC').all(type,Number(id),tenantId)
    : db.prepare('SELECT id FROM asset_view_bundles WHERE asset_type=? AND asset_id=? ORDER BY rowid DESC').all(type,Number(id));
  return rows.map(row=>get(db,row.id));
}
async function create(db,log,cfg,type,id,body={}) {
  init(db);const spec=compiler.definition(type);
  const tenantId = getTenantId();
  const row = tenantId
    ? db.prepare(`SELECT x.* FROM ${spec.table} x JOIN dramas d ON d.id=x.drama_id WHERE x.id=? AND x.deleted_at IS NULL AND d.organization_id=?`).get(Number(id), tenantId)
    : db.prepare(`SELECT * FROM ${spec.table} WHERE id=? AND deleted_at IS NULL`).get(Number(id));
  if(!row)throw new Error('资产不存在');
  const revision=compiler.inputHash(row,spec);
  if(body.input_revision && revision!==body.input_revision) { const e=new Error('资产描述已变化，请刷新后生成完整视图');e.status=409;throw e; }
  const input=Object.fromEntries(spec.fields.map(key=>[key,Object.hasOwn(body.input||{},key)?String(body.input[key]??''):row[key]||'']));
  const includeTop=body.include_top === true;
  const layout=layouts(type,body.front_axis,includeTop);
  const settings=skills.getSettings(db,row.drama_id);
  const pack=settings.asset_pack_id?skills.getPack(db,settings.asset_pack_id):null;
  const drama=db.prepare('SELECT style,metadata FROM dramas WHERE id=?').get(row.drama_id);
  const render=policy.mergeAssetStyle(cfg,drama).style;
  const custom=skills.getModulePrompt(db,row.drama_id,spec.module);
  const raw=await ai.generateText(db,log,'text',JSON.stringify({input,layouts:layout,render_style:render.default_style_zh||render.default_style}),
    `${custom}\n${policy.contract(spec.module, 'full_views')}\n当前任务为完整视图包，采用以下已明确选定的布局契约，取代单图/旧四宫格输出：${JSON.stringify(layout)}。同一版本内锁定全部几何与身份。只输出JSON对象，键为布局ID，值为该物理图片的完整提示词，不生成其他资产或文件。`,{scene_key:spec.scene,max_tokens:5000,model:body.model||undefined});
  const result=safeParseAIJSON(raw,null,log);
  if(compiler.inputHash(db.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).get(Number(id)),spec)!==revision || skills.getSettings(db,row.drama_id).asset_pack_id!==settings.asset_pack_id) {const e=new Error('编译期间资产或 Skill 已变化，本次视图包未发布');e.status=409;throw e;}
  const bundleId=crypto.randomUUID();
  const label=String(row.name||row.location||type).replace(/[<>:"/\\|?*]/g,'_');
  const parts=Object.entries(layout).map(([key,rule])=>{
    if(typeof result?.[key]!=='string'||!result[key].trim())throw new Error(`视图 ${key} 未返回有效提示词`);
    return {key,prompt:`${rule}\n${result[key]}\n${policy.contract(spec.module, key)}\n渲染质感：${render.default_style_en||render.default_style_zh||''}`,file_name:`${label}${type==='scene'?'场景':''}${id}_${key==='top90'?'顶俯视图':key==='orthographic_4view'?'正反左右四视图':key}.png`,status:'draft',image_id:null};
  });
  const payload={version:1,source:pack?'skill':'builtin',pack_id:pack?.id||null,pack_version:pack?.version||null,input,input_revision:revision,front_axis:body.front_axis||null,include_top:includeTop,required_views:type==='scene'?[...(includeTop?['top90']:[]),'front','back','left','right']:type==='character'?['closeup','front','side','back']:['front','side','top','detail'],parts};
  db.prepare('INSERT INTO asset_view_bundles VALUES (?,?,?,?,?,?)').run(bundleId,type,Number(id),row.drama_id,JSON.stringify(payload),new Date().toISOString());
  return get(db,bundleId);
}
function generatePart(db,log,id,key,body={}) {
  const bundle=get(db,id);if(!bundle)throw new Error('视图包不存在');
  const part=bundle.payload.parts.find(p=>p.key===key);if(!part)throw new Error('视图不存在');
  if(['pending','processing','completed'].includes(part.status))throw new Error('该视图已提交或已成功；保留现有结果，只重试失败视图');
  const record=image.createAndGenerateImage(db,log,{drama_id:bundle.drama_id,prompt:part.prompt,model:body.model||undefined,size:'1792x1024',quality:'standard',provider:'openai'});
  part.image_id=record.id;part.status=record.status||'pending';
  db.prepare('UPDATE asset_view_bundles SET payload=? WHERE id=?').run(JSON.stringify(bundle.payload),id);
  return get(db,id);
}
function useReference(db,log,id,key) {
  const bundle=get(db,id),part=bundle?.payload.parts.find(p=>p.key===key);
  if(!part || part.status!=='completed' || !(part.local_path||part.image_url)) throw new Error('只能选择生成完成的视图作为参考图');
  const spec=compiler.definition(bundle.asset_type);
  db.transaction(()=>{
    const tenantId = getTenantId();
    const row = tenantId
      ? db.prepare(`SELECT x.* FROM ${spec.table} x JOIN dramas d ON d.id=x.drama_id WHERE x.id=? AND x.deleted_at IS NULL AND d.organization_id=?`).get(bundle.asset_id, tenantId)
      : db.prepare(`SELECT * FROM ${spec.table} WHERE id=? AND deleted_at IS NULL`).get(bundle.asset_id);
    if(!row) throw new Error('原资产已不存在');
    let extras=[];try{extras=JSON.parse(row.extra_images||'[]');}catch(_){}if(!Array.isArray(extras)) extras=[];
    const previous=row.local_path||row.image_url;
    if(previous&&!extras.includes(previous))extras.push(previous);
    if(bundle.asset_type==='character') require('../utils/seedance2AssetGuards').markStaleOnCharacterMainImageDrift(db,log,row,{image_url:part.image_url,local_path:part.local_path});
    db.prepare(`UPDATE ${spec.table} SET image_url=?,local_path=?,extra_images=?,updated_at=? WHERE id=?`).run(part.image_url||null,part.local_path||null,JSON.stringify(extras),new Date().toISOString(),bundle.asset_id);
  })();
  return {ok:true,message:'已设为当前资产参考图，原主图保留在历史图片中；后续新视频采用当前参考图'};
}
module.exports={init,layouts,get,list,create,generatePart,useReference};
