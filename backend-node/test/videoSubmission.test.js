const { test }=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const http=require('node:http');
const {runMigrationsAndEnsure}=require('../src/db/migrate');
const submissions=require('../src/services/videoSubmissionService');
const client=require('../src/services/videoClient');
const timeline=require('../src/services/videoTimelineValidation');
const log={info(){},warn(){},error(){},debug(){}};
function fixture(){
  const db=new Database(':memory:');runMigrationsAndEnsure(db);
  db.prepare("INSERT INTO dramas (id,title,created_at,updated_at) VALUES(1,'测试','now','now')").run();
  db.prepare("INSERT INTO episodes (id,drama_id,episode_number,title,created_at,updated_at) VALUES(1,1,1,'第一集','now','now')").run();
  db.prepare("INSERT INTO storyboards (id,episode_id,storyboard_number,title,duration,created_at,updated_at) VALUES(1,1,1,'取证',26,'now','now')").run();
  db.prepare("INSERT INTO ai_service_configs (id,service_type,provider,api_protocol,name,base_url,api_key,model,default_model,is_default,is_active,created_at,updated_at) VALUES (1,'video','doubao_manager','doubao_manager','测试','http://127.0.0.1:9999','test-secret','[\"Seedance 2.5\"]','Seedance 2.5',1,1,'now','now')").run();
  return db;
}
test('invalid requests create no orphan jobs; accepted jobs are immutable and deduplicated',t=>{
  const db=fixture();t.after(()=>db.close());
  for(const duration of [0,-1,null,'',29.7,25]) assert.throws(()=>submissions.enqueue(db,log,{drama_id:1,storyboard_id:1,prompt:'原文',duration}));
  assert.equal(db.prepare('SELECT count(*) n FROM async_tasks').get().n,0);
  const body={drama_id:1,storyboard_id:1,prompt:'原文',duration:26};
  const job=submissions.enqueue(db,log,body),again=submissions.enqueue(db,log,body);
  assert.equal(again.id,job.id);assert.equal(again.duplicate,true);
  db.prepare('UPDATE storyboards SET duration=30').run();
  const snap=submissions.get(db,job.id);
  assert.equal(snap.payload.duration,26);assert.equal(JSON.stringify(snap).includes('test-secret'),false);
  assert.equal(db.prepare('SELECT count(*) n FROM async_tasks').get().n,1);
});
test('timeline validation rejects changed total without altering original dialogue',()=>{
  const text='分镜1： 8秒: 原台词\n分镜2： 18秒: 门口停住';
  assert.equal(timeline.assertTimeline(text,26),text);
  assert.throws(()=>timeline.assertTimeline(text,25),/不自动按比例压缩/);
});
test('real manager HTTP submission carries exact 26 seconds',async t=>{
  let payload;
  const server=http.createServer((req,res)=>{let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>{payload=data;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({request_id:'unit-test-task'}));});});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const result=await client.callVideoApi(null,log,{config_snapshot:{id:1,provider:'doubao_manager',api_protocol:'doubao_manager',base_url:`http://127.0.0.1:${server.address().port}`,model:['Seedance 2.5']},model:'Seedance 2.5',duration:26,prompt:'取证后门口停住'});
  assert.equal(result.error,undefined,JSON.stringify(result));
  assert.match(payload,/name="duration"\r\n\r\n26\r\n/);
});
test('adapter checks run before writing and preserve exact-model configuration',t=>{
  const db=fixture();t.after(()=>db.close());
  db.prepare("UPDATE ai_service_configs SET api_protocol='agnes',model='[\"agnes-video-2.5-flash\"]',default_model='agnes-video-2.5-flash',settings=?").run(JSON.stringify({video_duration:{mode:'range',min_seconds:4,max_seconds:30}}));
  assert.throws(()=>submissions.enqueue(db,log,{drama_id:1,storyboard_id:1,prompt:'原文',duration:26}),/通道编码/);
  assert.equal(db.prepare('SELECT count(*) n FROM async_tasks').get().n,0);
  db.prepare('UPDATE storyboards SET duration=10').run();
  assert.throws(()=>submissions.enqueue(db,log,{drama_id:1,storyboard_id:1,prompt:'原文',duration:10,reference_image_urls:Array.from({length:6},(_,i)=>`https://example.com/${i}.png`)}),/最多 5 张/);
});
test('unknown submission remains deduplicated and frozen endpoint survives default changes',t=>{
  const db=fixture();t.after(()=>db.close());const body={drama_id:1,storyboard_id:1,prompt:'原文',duration:26};
  const job=submissions.enqueue(db,log,body);submissions.mark(db,job.id,'submission_unknown');
  db.prepare("UPDATE video_generations SET status='failed' WHERE id=?").run(job.id);
  assert.equal(submissions.enqueue(db,log,body).id,job.id);
  const snap=submissions.get(db,job.id);
  db.prepare("UPDATE ai_service_configs SET base_url='http://127.0.0.1:9876',api_key='rotated-secret'").run();
  const frozen=submissions.configFor(db,snap);
  assert.equal(frozen.base_url,'http://127.0.0.1:9999');assert.equal(frozen.api_key,'rotated-secret');
});
