const crypto = require('crypto');
const ai = require('./aiClient');
const video = require('./videoClient');
const { safeParseAIJSON } = require('../utils/safeJson');
const { getTenantId } = require('../utils/tenantContext');
const STATE_KEYS = ['world_position','body_orientation','gaze','posture','momentum','left_hand','right_hand','held_props','weapons','injuries','doors_windows','environment','effects','emotion','sound'];
function blocked(message) { const e=new Error(`BLOCKED_REVIEW：${message}`); e.code='BLOCKED_REVIEW'; throw e; }
function sourceLines(script) {
  let offset=0;
  return String(script).split(/(?<=\n)/).map((text,index)=>{const row={id:`L${index+1}`,start:offset,end:offset+text.length,text};offset+=text.length;return row;}).filter(r=>r.text.trim());
}
function checkState(state, label) {
  for(const key of STATE_KEYS) if(typeof state?.[key] !== 'string' || !state[key].trim() || /^(同前|延续上一单元|保持不变|same|unchanged)$/i.test(state[key].trim())) blocked(`${label}.${key} 必须写出具体状态或明确不适用`);
}
function dialogueLine(source) {
  const m=source.text.trim().match(/^([\p{L}\p{N}_·（）() ]{1,24})[：:]\s*(.+)$/u);
  if(!m || /^(场景|时间|地点|人物|画面|动作|音效|标题|Scene|Time|Location)$/i.test(m[1])) return null;
  return {speaker:m[1].trim(),text:m[2]};
}
function schedule(events) {
  if(!Array.isArray(events)||!events.length) blocked('事件列表为空');
  const byId=new Map(),times=new Map(),visiting=new Set();
  for(const event of events) {
    if(typeof event.id!=='string'||!event.id||byId.has(event.id)) blocked('事件 ID 缺失或重复');
    if(!Number.isInteger(event.duration_ms)||event.duration_ms<0||(event.duration_ms===0&&event.kind!=='initial')) blocked(`事件 ${event.id} 时长必须是正整数毫秒（初始状态标记可为0）`);
    if(!Array.isArray(event.depends_on)||!Array.isArray(event.resources)) blocked(`事件 ${event.id} 缺少依赖或资源锁`);
    byId.set(event.id,event);
  }
  function visit(id) {
    if(times.has(id)) return times.get(id);
    if(visiting.has(id)) blocked(`事件依赖存在环：${id}`);
    const e=byId.get(id);if(!e) blocked(`缺少依赖事件 ${id}`);
    visiting.add(id);
    const start=Math.max(0,...e.depends_on.map(dep=>visit(dep).end));
    const time={start,end:start+e.duration_ms};times.set(id,time);visiting.delete(id);return time;
  }
  for(const e of events) visit(e.id);
  for(let i=0;i<events.length;i++) for(let j=i+1;j<events.length;j++) {
    const a=events[i],b=events[j],ta=times.get(a.id),tb=times.get(b.id);
    if(ta.start<tb.end&&tb.start<ta.end&&a.resources.some(resource=>b.resources.includes(resource))) blocked(`${a.id}/${b.id} 同时占用同一人物/手/道具资源，请建立顺序依赖`);
  }
  return { duration_ms:Math.max(...[...times.values()].map(t=>t.end)), times:Object.fromEntries(times) };
}
function requestSeconds(estimatedMs,capacity,cap,closure) {
  const required=Math.ceil(estimatedMs/1000);
  let seconds;
  if(cap.mode==='invalid') blocked(cap.error);
  if(cap.mode==='fixed') seconds=cap.allowed_seconds.find(s=>s>=required&&s<=capacity);
  else { seconds=Math.max(cap.min,required); seconds=cap.min+Math.ceil((seconds-cap.min)/cap.step)*cap.step; if(seconds>Math.min(capacity,cap.max)) seconds=null; }
  if(!seconds) blocked(`自然闭合需 ${estimatedMs/1000} 秒，容量 ${capacity} 秒内没有合法通道时长，请拆分或更换通道`);
  // Sub-second quantization can show the existing stable result; larger fixed-slot gaps need re-planning.
  if(seconds*1000-estimatedMs>1000 || !closure?.visual || !closure?.narrative) blocked(`闭合 ${estimatedMs/1000} 秒不能硬填至通道档位 ${seconds} 秒，请重新规划`);
  return seconds;
}
function validatePlan(plan,script,capacity,cap,manualCount,context={}) {
  if(![4,5,8,10,12,15,20,25,30].includes(capacity)) blocked('不支持的单元容量');
  const sources=context.sources || sourceLines(script),sourceById=new Map(sources.map(s=>[s.id,s]));
  if(!Array.isArray(plan?.units)||!plan.units.length) blocked('规划没有单元');
  const allIds=new Set(),covered=new Map(); let previous=null;
  const units=plan.units.map((unit,index)=>{
    if(typeof unit.main_arc!=='string'||!unit.main_arc.trim()||!Array.isArray(unit.auxiliary_modes)||unit.auxiliary_modes.length>2) blocked(`单元 ${index+1} 必须恰好一条主弧、最多两种辅助模式`);
    if(!['A_CONTINUOUS','B_TRANSFER','C_NARRATIVE_JUMP'].includes(unit.space_type)) blocked(`单元 ${index+1} 缺少空间类型`);
    checkState(unit.initial_state,`单元${index+1}.initial_state`);checkState(unit.final_state,`单元${index+1}.final_state`);
    if(previous && unit.space_type!=='C_NARRATIVE_JUMP' && STATE_KEYS.some(key=>unit.initial_state[key]!==previous.final_state[key])) blocked(`单元 ${index+1} 第 0 秒未完整继承上一单元状态`);
    if(previous && unit.space_type==='C_NARRATIVE_JUMP' && !String(unit.transition_reason||'').trim()) blocked(`单元 ${index+1} 叙事跳跃必须说明原文中的时间或空间跳跃依据`);
    for(const event of unit.events || []) if(event.kind!=='camera' && event.depends_on?.some(id=>unit.events.some(e=>e.id===id&&e.kind==='camera'))) blocked('摄影机轨道必须随故事时间线并行，不能让剧情等待摄影机来延长时长');
    const result=schedule(unit.events);
    if(result.duration_ms>capacity*1000) blocked(`单元 ${index+1} 关键路径 ${result.duration_ms/1000} 秒超过容量 ${capacity} 秒`);
    const ids=new Set(unit.events.map(e=>e.id));
    const initial = unit.events.find(e=>e.kind==='initial');
    const ancestors = id => {
      const e = unit.events.find(item=>item.id===id);
      return new Set((e?.depends_on || []).flatMap(dep=>[dep,...ancestors(dep)]));
    };
    if (initial && unit.events.some(e=>e.id!==initial.id && !ancestors(e.id).has(initial.id))) blocked(`单元 ${index+1} 的初始状态未纳入完整关键路径`);
    for(const event of unit.events) {
      if(allIds.has(event.id)) blocked(`跨单元重复事件 ${event.id}`);allIds.add(event.id);
      if(!Array.isArray(event.source_ids)||!event.source_ids.length) blocked(`事件 ${event.id} 缺少原文依据`);
      for(const id of event.source_ids) {
        if(!sourceById.has(id)) blocked(`事件 ${event.id} 引用了不存在的原文 ${id}`);
        if(covered.has(id)&&covered.get(id)!==index) blocked(`原文 ${id} 被切到多个单元，请将完整语义放在同一单元`);
        covered.set(id,index);
      }
      if(!Array.isArray(event.must_complete_with)||event.must_complete_with.some(id=>!ids.has(id))) blocked(`不可切分事件 ${event.id} 的反应/结果缺失或被切到下一单元`);
      if(event.kind==='dialogue') {
        if(typeof event.dialogue!=='string'||!event.dialogue.trim()||!event.source_ids.some(id=>sourceById.get(id).text.includes(event.dialogue))) blocked(`事件 ${event.id} 的台词与原文不一致`);
        const isReply = require('./narrativePlanningV2').isDialogueReply(event, unit.events);
        if(!event.must_complete_with.length && !isReply) blocked(`对白 ${event.id} 的回应关联未明确（允许已有回答或动作承担）`);
        // Conservative baseline; performance can be slower but never abnormally sped up.
        if(event.duration_ms < require('./narrativePlanningV2').dialogueMinimum(event.dialogue)) blocked(`对白 ${event.id} 语速超过每秒 5 字，请保留台词重新分段`);
      }
      if(event.kind==='camera' && result.times[event.id].end>Math.max(...unit.events.filter(e=>e.kind!=='camera').map(e=>result.times[e.id].end))) blocked('摄影机不能延长故事时间线');
    }
    const hasResponse = unit.events.some(e => ['reaction','result'].includes(e.kind) ||
      (e.kind === 'dialogue' && require('./narrativePlanningV2').isDialogueReply(e, unit.events)));
    if(!unit.events.some(e=>e.kind==='initial')||!hasResponse) blocked(`单元 ${index+1} 缺少初始状态或独立反应/结果事件`);
    const closure=unit.closure;
    if(!closure?.event_id||!ids.has(closure.event_id)||result.times[closure.event_id].end!==result.duration_ms||!closure.narrative||!closure.visual||!closure.reason) blocked(`单元 ${index+1} 未在叙事与视觉双重闭合点结束`);
    const closed = ancestors(closure.event_id);
    if (unit.events.some(e=>e.kind!=='camera' && e.id!==closure.event_id && !closed.has(e.id))) blocked(`单元 ${index+1} 存在未与闭合点汇合的时间轨`);
    const seconds=requestSeconds(result.duration_ms,capacity,cap,closure);
    const source_spans=sources.filter(s=>unit.events.some(e=>e.source_ids.includes(s.id)));
    previous=unit;
    return {...unit,index:index+1,capacity_ms:capacity*1000,estimated_story_ms:result.duration_ms,request_duration_ms:seconds*1000,schedule:result.times,source_spans};
  });
  for(const source of sources) if(!covered.has(source.id)) blocked(`原文 ${source.id} 未覆盖，不允许遗漏剧情或台词`);
  for(const source of sources) {
    const spoken=dialogueLine(source);if(!spoken)continue;
    const matches=units.flatMap(unit=>unit.events).filter(e=>e.kind==='dialogue'&&e.source_ids.includes(source.id)&&e.dialogue===spoken.text&&e.speaker===spoken.speaker);
    if(matches.length!==1) blocked(`原文 ${source.id} 的完整台词或说话人未被准确保留：${spoken.speaker}`);
  }
  for(let i=1;i<sources.length;i++) if(covered.get(sources[i].id)<covered.get(sources[i-1].id)) blocked('单元重排了原文顺序，请保持叙事节奏');
  if(manualCount && units.length!==manualCount) blocked(`人工要求 ${manualCount} 段，完整语义规划为 ${units.length} 段，请调整数量或人工复核，不能删除原文`);
  return {...plan,version:1,units,source_hash:crypto.createHash('sha256').update(script).digest('hex')};
}
function init(db) { db.exec(`CREATE TABLE IF NOT EXISTS narrative_unit_plans (id TEXT PRIMARY KEY, episode_id INTEGER NOT NULL, status TEXT NOT NULL, payload TEXT, error TEXT, created_at TEXT NOT NULL);`); }
function forStoryboard(db, sbId) {
  init(db);
  const tenantId = getTenantId();
  const sb = tenantId
    ? db.prepare('SELECT s.episode_id FROM storyboards s JOIN episodes e ON e.id=s.episode_id WHERE s.id=? AND COALESCE(e.organization_id,1)=?').get(Number(sbId), tenantId)
    : db.prepare('SELECT episode_id FROM storyboards WHERE id=?').get(Number(sbId));
  if (!sb) return null;
  const rows = db.prepare("SELECT id,payload FROM narrative_unit_plans WHERE episode_id=? AND status='published' ORDER BY rowid DESC").all(sb.episode_id);
  for (const row of rows) {
    const plan = JSON.parse(row.payload), index = plan.storyboard_ids?.indexOf(Number(sbId));
    if (index >= 0) return { plan_id: row.id, source_hash: plan.source_hash, ...plan.units[index] };
  }
  return null;
}
async function generate(db,log,episodeId,model,capacity,manualCount,settings={}) {
  if (settings?._useValidatedPlan !== true) {
    return require('./narrativePlanningV2').generate(db,log,episodeId,model,capacity,manualCount,settings,module.exports);
  }
  init(db);
  const tenantId = getTenantId();
  const episode = tenantId
    ? db.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL AND COALESCE(organization_id,1)=?').get(Number(episodeId), tenantId)
    : db.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL').get(Number(episodeId));
  if(!episode) blocked('剧集不存在');
  const script=String(episode.script_content||'');
  const config=video.getDefaultVideoConfig(db);
  if(!config) blocked('请先配置视频模型能力');
  const capability=video.getVideoDurationCapability(config);
  const id=crypto.randomUUID();
  db.prepare('INSERT INTO narrative_unit_plans VALUES (?,?,?,?,?,?)').run(id,Number(episodeId),'planning',null,null,new Date().toISOString());
  let raw;
  try {
    const system=`你只做原剧本事件规划，不重写原文、不调用视频提示词 Skill。容量 ${capacity} 秒是上限，不是填满目标；18～25 秒自然弧可闭合，26 秒优先于无功能拖延。一次只一条主叙事弧，最多2辅助模式。先拆最小事件、建立依赖、标记不可切分事件，再从所有候选点选择容量内最后一个高质量叙事+视觉闭合点。顺序阶段相加，并行取关键路径；摄影机随动作并行，不额外计时。同人物同手不可并行动作。不能新增剧情/冲突/攻击/特效，不能改对白或异常加速。对白必须连同听者反应；决定须有行动；攻击须接触/防御/落空；特效须反馈；交接须接收/拒绝；开门须结果；跨空间须稳定站位；跨障碍须落地；跌倒须最终姿态；争夺须归属；追逐转向须建立路线。超时依次并行化、去无功能镜头和重复反馈、压缩非关键停顿、更早闭合、顺延完整语义，仍不容纳则输出 blocked 原因。不要删原文事件。A_CONTINUOUS/B_TRANSFER可保持同单元，C_NARRATIVE_JUMP另起单元。状态必须逐字段显式描述，连续空间下一单元第0秒与上单元final_state逐字相同；C_NARRATIVE_JUMP写出原文跳跃依据transition_reason，并完整写出跳跃后的初始状态。摄影机camera随动作并行，任何故事事件不得依赖camera，摄影机结束不能晚于故事闭合。\n只输出 JSON：{units:[{main_arc:string,auxiliary_modes:[],space_type:'A_CONTINUOUS',initial_state:{...},final_state:{...},events:[{id:'e1',kind:'initial|dialogue|action|reaction|result|sound|effect|camera',duration_ms:1000,depends_on:[],resources:['人物.左手'],source_ids:['L1'],must_complete_with:[],speaker:'对白行冒号前的原文说话人',dialogue:'对白行冒号后的完整原文'}],closure:{event_id:'结果事件ID',narrative:true,visual:true,reason:'可观察闭合结果'}}]}。状态字段均为字符串：${STATE_KEYS.join(',')}。每个单元事件ID全局唯一；依赖只在单元内；每个事件须经初始状态事件到达，所有并行轨须汇合到闭合结果；必须覆盖全部非空原文行。格式“说话人：台词”的每行必须恰好一个dialogue事件，speaker与dialogue逐字保留冒号两侧原文，不省略括号表演说明。`;
    raw=await ai.generateText(db,log,'text',JSON.stringify({capacity_seconds:capacity,capability,manual_count:manualCount||null,source_lines:sourceLines(script)}),system,{scene_key:'storyboard_extraction',model:model||undefined,max_tokens:16384});
    const parsed=safeParseAIJSON(raw,null,log);
    if(parsed?.blocked) blocked(String(parsed.blocked));
    const plan=validatePlan(parsed,script,capacity,capability,manualCount);
    db.prepare("UPDATE narrative_unit_plans SET status='validated',payload=? WHERE id=?").run(JSON.stringify(plan),id);
    return {id,...plan};
  } catch(err) { db.prepare("UPDATE narrative_unit_plans SET status='blocked',payload=?,error=? WHERE id=?").run(raw||null,err.message,id);throw err; }
}
function validateBoards(boards,plan) {
  if(boards.length!==plan.units.length) blocked('分镜数量与已验证单元计划不符');
  for(let i=0;i<boards.length;i++) {
    const board=boards[i],unit=plan.units[i];
    if(Number(board.duration)*1000!==unit.request_duration_ms) blocked(`第 ${i+1} 段提示词时长与冻结计划不符`);
    for(const event of unit.events.filter(e=>e.kind==='dialogue')) if(!String(board.dialogue||'').includes(event.dialogue)) blocked(`第 ${i+1} 段遗漏或改写了对白 ${event.id}`);
  }
}
module.exports={...require('./narrativePlanningV2'),STATE_KEYS,sourceLines,dialogueLine,schedule,requestSeconds,validatePlan,validateBoards,generate,init,forStoryboard};
