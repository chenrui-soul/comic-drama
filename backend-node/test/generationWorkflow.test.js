const { test }=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const Database=require('better-sqlite3');
const {runMigrationsAndEnsure}=require('../src/db/migrate');
const ai=require('../src/services/aiClient');
const planner=require('../src/services/narrativeUnitPlanner');
const storyboards=require('../src/services/episodeStoryboardService');
const bundles=require('../src/services/assetViewBundles');
const log={info(){},warn(){},error(){},debug(){}};
function fixture(){
  const db=new Database(':memory:');runMigrationsAndEnsure(db);
  db.prepare("INSERT INTO dramas (id,title,metadata,created_at,updated_at) VALUES(1,'测试',?, 'now','now')").run(JSON.stringify({video_clip_duration:30,video_clip_duration_mode:'capacity'}));
  db.prepare("INSERT INTO episodes (id,drama_id,episode_number,title,script_content,created_at,updated_at) VALUES(1,1,1,'第一集','发现证据，然后走到门口停住','now','now')").run();
  db.prepare("INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration,created_at,updated_at) VALUES(1,1,1,'原有分镜',15,'now','now')").run();
  db.prepare("INSERT INTO scenes (id,drama_id,location,time,prompt,created_at,updated_at) VALUES(1,1,'房间','白天','东侧有窗','now','now')").run();
  db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,api_protocol,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at) VALUES (1,'video','doubao_manager','doubao_manager','测试','http://127.0.0.1:9999','test-only','[\"Seedance 2.5\"]','Seedance 2.5',1,1,'now','now')").run();
  return db;
}
function plan(){const state=Object.fromEntries(planner.STATE_KEYS.map(k=>[k,`${k}：明确不适用`]));return {units:[{main_arc:'证据到门口',auxiliary_modes:[],space_type:'A_CONTINUOUS',initial_state:state,final_state:state,events:[{id:'start',kind:'initial',duration_ms:1000,depends_on:[],resources:[],source_ids:['L1'],must_complete_with:[]},{id:'result',kind:'result',duration_ms:25000,depends_on:['start'],resources:['人.双腿'],source_ids:['L1'],must_complete_with:[]}],closure:{event_id:'result',narrative:true,visual:true,reason:'门口站稳'}}]};}
async function waitTask(db,id){for(let i=0;i<100;i++){const task=db.prepare('SELECT * FROM async_tasks WHERE id=?').get(id);if(['completed','failed'].includes(task.status))return task;await new Promise(r=>setTimeout(r,10));}throw Error('task did not finish');}
test('30-second workflow plans 26 seconds then atomically publishes boards',async t=>{
  const db=fixture();t.after(()=>db.close());let calls=0;
  t.mock.method(ai,'generateText',async(_d,_l,_k,user,system)=>{
    calls++;if(calls===1)return JSON.stringify(plan());
    assert.match(user,/request_duration_ms.*26000/s);assert.match(system,/视频 Skill 仍在保存后的逐镜润色/);
    return JSON.stringify([{shot_number:1,title:'取证',duration:26,action:'发现证据，然后走到门口停住',dialogue:'',result:'门口站稳',characters:[]}]);
  });
  const job=storyboards.generateStoryboard(db,log,1,undefined,undefined,10,undefined,undefined,false,true,'auto');
  const out=await waitTask(db,job.task_id);assert.equal(out.status,'completed',out.error);
  const current=db.prepare('SELECT * FROM storyboards WHERE deleted_at IS NULL').all();assert.equal(current.length,1);assert.equal(current[0].duration,26);
  assert.ok(db.prepare('SELECT deleted_at FROM storyboards WHERE id=1').get().deleted_at);
  assert.equal(planner.forStoryboard(db,current[0].id).request_duration_ms,26000);
});
test('failed plan retains existing boards and records blocked draft',async t=>{
  const db=fixture();t.after(()=>db.close());t.mock.method(ai,'generateText',async()=>JSON.stringify({blocked:'核心对白无法容纳'}));
  const job=storyboards.generateStoryboard(db,log,1,undefined,undefined,null,undefined,undefined,false,true,'auto');
  const out=await waitTask(db,job.task_id);assert.equal(out.status,'failed');assert.match(out.error,/BLOCKED_REVIEW/);
  assert.equal(db.prepare('SELECT deleted_at FROM storyboards WHERE id=1').get().deleted_at,null);
});
test('HTTP scene single prompt uses edited description and correct model route',async t=>{
  const db=fixture();t.after(()=>db.close());
  t.mock.method(ai,'generateText',async(_d,_l,_k,user,_system,opts)=>{assert.match(user,/西侧有门/);assert.equal(opts.scene_key,'scene_image_polish');return '西侧有门的房间单图';});
  const app=express();app.use(express.json());app.post('/scenes/:scene_id/generate-prompt',require('../src/routes/scenes')(db,log,{style:{}}).generatePrompt);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/scenes/1/generate-prompt`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'single',input:{prompt:'西侧有门'}})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.ok(body.data.polished_prompt_single);assert.equal(body.data.prompt_status.state,'ready');
  assert.equal(db.prepare('SELECT polished_prompt,prompt FROM scenes').get().polished_prompt,null);
});
test('scene bundle has two physical outputs and retries only a failed part',async t=>{
  const db=fixture();t.after(()=>db.close());
  t.mock.method(ai,'generateText',async()=>JSON.stringify({top90:'东侧窗的顶视',orthographic_4view:'东侧窗的正反左右'}));
  const bundle=await bundles.create(db,log,{style:{}},'scene',1,{front_axis:'面向北墙为正面',include_top:true});
  assert.equal(bundle.payload.parts.length,2);assert.equal(bundle.payload.required_views.length,5);
  assert.equal(db.prepare('SELECT image_url FROM scenes WHERE id=1').get().image_url,null);
  const image=require('../src/services/imageClient');let created=0;
  t.mock.method(image,'createAndGenerateImage',(_db,_log,opts)=>{created++;assert.equal(opts.scene_id,undefined);const r=db.prepare("INSERT INTO image_generations (drama_id,provider,prompt,status,created_at,updated_at) VALUES(1,'test',?,'failed','now','now')").run(opts.prompt);return {id:Number(r.lastInsertRowid),status:'failed'};});
  const first=bundles.generatePart(db,log,bundle.id,'top90');
  bundles.generatePart(db,log,bundle.id,'top90');assert.equal(created,2);
  assert.equal(first.payload.parts[1].image_id,null);
});
test('scene defaults to four views without a top view and history stays available',async t=>{
  const db=fixture();t.after(()=>db.close());
  t.mock.method(ai,'generateText',async(_d,_l,_k,user)=>{assert.equal(JSON.parse(user).layouts.top90,undefined);return JSON.stringify({orthographic_4view:'北面入口，四个方向共享同一空间'});});
  const bundle=await bundles.create(db,log,{style:{}},'scene',1,{front_axis:'北面入口为正面'});
  assert.deepEqual(bundle.payload.required_views,['front','back','left','right']);
  assert.equal(bundle.payload.parts.length,1);
  assert.equal(bundles.list(db,'scene',1)[0].id,bundle.id);
});

test('selecting completed bundle references preserves previous images and invalidates character certification', t => {
  const db = fixture(); t.after(() => db.close()); bundles.init(db);
  db.prepare("INSERT INTO characters(id,drama_id,name,created_at,updated_at) VALUES(1,1,'父亲','now','now')").run();
  db.prepare("INSERT INTO props(id,drama_id,name,created_at,updated_at) VALUES(1,1,'报告','now','now')").run();
  for (const [type, table] of [['character', 'characters'], ['scene', 'scenes'], ['prop', 'props']]) {
    db.prepare(`UPDATE ${table} SET local_path='old.png',extra_images='[]' WHERE id=1`).run();
    if (type === 'character') db.prepare('UPDATE characters SET seedance2_asset=? WHERE id=1').run(JSON.stringify({ status: 'active' }));
    const payload = { parts: [{ key: 'main', status: 'draft', local_path: 'new.png' }] };
    db.prepare('INSERT INTO asset_view_bundles VALUES(?,?,?,?,?,?)').run(type, type, 1, 1, JSON.stringify(payload), 'now');
    assert.throws(() => bundles.useReference(db, log, type, 'main'), /生成完成/);
    assert.equal(db.prepare(`SELECT local_path FROM ${table} WHERE id=1`).get().local_path, 'old.png');
    payload.parts[0].status = 'completed';
    db.prepare('UPDATE asset_view_bundles SET payload=? WHERE id=?').run(JSON.stringify(payload), type);
    assert.equal(bundles.useReference(db, log, type, 'main').ok, true);
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=1`).get();
    assert.equal(row.local_path, 'new.png');
    assert.deepEqual(JSON.parse(row.extra_images), ['old.png']);
    if (type === 'character') assert.equal(JSON.parse(row.seedance2_asset).status, 'stale');
  }
});
