const { test }=require('node:test');
const assert=require('node:assert/strict');
const p=require('../src/services/narrativeUnitPlanner');
const event=(id,duration_ms,depends_on=[],resources=[])=>({id,duration_ms,depends_on,resources});
test('parallel eight and five seconds followed by four has a 12-second critical path',()=>{
  const out=p.schedule([event('a',8000),event('b',5000),event('c',4000,['a','b'])]);
  assert.equal(out.duration_ms,12000);
});
test('cycles, missing dependencies, duplicate events and shared hand collisions are blocked',()=>{
  for(const events of [[event('a',1,['b']),event('b',1,['a'])],[event('a',1,['missing'])],[event('a',1),event('a',2)],[event('a',5,[],['父亲.左手']),event('b',5,[],['父亲.左手'])]]) assert.throws(()=>p.schedule(events),/BLOCKED_REVIEW/);
});
test('natural closure is rounded before compilation and never padded to a fixed slot',()=>{
  const closure={narrative:true,visual:true}; const range={mode:'range',min:4,max:30,step:1};
  assert.equal(p.requestSeconds(25600,30,range,closure),26);
  assert.equal(p.requestSeconds(18000,30,range,closure),18);
  assert.throws(()=>p.requestSeconds(26000,25,range,closure),/BLOCKED_REVIEW/);
  assert.throws(()=>p.requestSeconds(26000,30,{mode:'fixed',allowed_seconds:[15,30]},closure),/硬填/);
  assert.throws(()=>p.requestSeconds(23000,25,{mode:'fixed',allowed_seconds:[15,30]},closure),/没有合法/);
});
test('source coverage, explicit handoff and unsplit reactions are validated',()=>{
  const state=Object.fromEntries(p.STATE_KEYS.map(k=>[k,`${k}：不适用`]));
  const script='发现证据\n走到门口并停住';
  const plan={units:[{main_arc:'发现证据后靠近门口',auxiliary_modes:[],space_type:'A_CONTINUOUS',initial_state:state,final_state:state,
    events:[{...event('a',1000),kind:'initial',source_ids:['L1'],must_complete_with:[]},{...event('b',25000,['a']),kind:'result',source_ids:['L2'],must_complete_with:[]}],closure:{event_id:'b',narrative:true,visual:true,reason:'门口稳定站位'}}]};
  const cap={mode:'range',min:4,max:30,step:1};
  const out=p.validatePlan(plan,script,30,cap);
  assert.equal(out.units[0].request_duration_ms,26000);
  assert.equal(out.units[0].source_spans.map(s=>s.text).join(''),script);
  assert.throws(()=>p.validatePlan(plan,script+'\n不能丢的事件',30,cap),/未覆盖/);
  plan.units[0].final_state={...state,left_hand:'同前'};
  assert.throws(()=>p.validatePlan(plan,script,30,cap),/必须写出具体状态/);
});
test('Chinese dialogue and speaker changes block publication; camera cannot extend story time',()=>{
  const state=Object.fromEntries(p.STATE_KEYS.map(k=>[k,`${k}：不适用（本段无此对象）`]));
  const script='父亲：把报告给我。\n女儿听后递出报告。';
  const plan={units:[{main_arc:'父亲索取报告',auxiliary_modes:[],space_type:'A_CONTINUOUS',initial_state:state,final_state:state,events:[
    {...event('start',1000),kind:'initial',source_ids:['L1'],must_complete_with:[]},
    {...event('talk',2000,['start']),kind:'dialogue',speaker:'父亲',dialogue:'把报告给我。',source_ids:['L1'],must_complete_with:['end']},
    {...event('end',2000,['talk']),kind:'result',source_ids:['L2'],must_complete_with:[]},
  ],closure:{event_id:'end',narrative:true,visual:true,reason:'接收到报告'}}]};
  const cap={mode:'range',min:4,max:30,step:1};
  assert.equal(p.validatePlan(plan,script,30,cap).units[0].request_duration_ms,5000);
  const changed=structuredClone(plan);changed.units[0].events[1].speaker='女儿';
  assert.throws(()=>p.validatePlan(changed,script,30,cap),/说话人/);
  const camera=structuredClone(plan);camera.units[0].events.push({...event('cam',8000,['start']),kind:'camera',source_ids:['L1'],must_complete_with:[]});
  assert.throws(()=>p.validatePlan(camera,script,30,cap),/摄影机/);
});
