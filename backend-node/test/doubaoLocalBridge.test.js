const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), express = require('express');
const Database = require('better-sqlite3');
const { DoubaoLocalBridge, allowedRequest, localOrigin } = require('../src/services/doubaoLocalBridge');
const { executeJob } = require('../scripts/doubao-connector.cjs');
const { runWithTenant } = require('../src/utils/tenantContext');
const { transport, management } = require('../src/routes/doubaoLocal');
const { EventEmitter } = require('events');
function setup(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE organizations(id INTEGER PRIMARY KEY); CREATE TABLE users(id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE organization_members(user_id INTEGER,organization_id INTEGER,role TEXT);
    CREATE TABLE ai_service_configs(id INTEGER PRIMARY KEY,organization_id INTEGER,service_type TEXT,provider TEXT,api_protocol TEXT,base_url TEXT,deleted_at TEXT);
    INSERT INTO organizations VALUES(10),(20); INSERT INTO users VALUES(1,'active'),(2,'active');
    INSERT INTO organization_members VALUES(1,10,'owner'),(2,20,'owner');
    INSERT INTO ai_service_configs VALUES(1,10,'video','doubao_manager','doubao_manager','http://127.0.0.1:8787',NULL),
      (2,20,'video','doubao_manager','doubao_manager','http://127.0.0.1:8787',NULL),
      (3,10,'image','openai','','https://api.example.com',NULL);`);
  db.exec(fs.readFileSync(path.join(__dirname,'../migrations/35_doubao_local_access.sql'),'utf8'));
  let time=100000;
  const bridge=new DoubaoLocalBridge(db,{now:()=>time,pollMs:50,timeoutMs:1000});
  t.after(()=>{bridge.close();db.close();});
  const config=db.prepare('SELECT * FROM ai_service_configs WHERE id=1').get();
  const pairing=bridge.pair(1,10,1), auth=bridge.authenticate(pairing.token);
  const request=(url,options)=>runWithTenant(10,()=>bridge.request(config,url,options));
  function online(){bridge.clients.set(1,{id:'client-a',seen:time,managerOnline:true});}
  return {db,bridge,config,auth,pairing,request,online,advance:()=>{time+=46000;}};
}
test('default off, tenant and service boundaries, fresh state, token rotation and offline rejection',async t=>{
  const s=setup(t),url='http://127.0.0.1:8787/health';
  assert.equal(s.bridge.status(1,10).enabled,false);
  await assert.rejects(s.request(url),/已关闭/);
  assert.throws(()=>s.bridge.setEnabled(1,20,2,true),/只适用于/);
  assert.throws(()=>s.bridge.pair(3,10,1),/只适用于/);
  s.bridge.setEnabled(1,10,1,true);
  await assert.rejects(s.request(url),/离线/);
  s.online();s.advance();await assert.rejects(s.request(url),/离线/);
  const newPair=s.bridge.pair(1,10,1);assert.equal(s.bridge.authenticate(s.pairing.token),null);assert(s.bridge.authenticate(newPair.token));
  s.db.prepare("UPDATE organization_members SET role='member' WHERE user_id=1").run();assert.equal(s.bridge.authenticate(newPair.token),null);
});
test('multipart reference bytes and results cross only the paired workspace, then revocation cancels queued work',async t=>{
  const s=setup(t);s.bridge.setEnabled(1,10,1,true);s.online();
  const form=new FormData();form.set('prompt','test scene');form.append('files',new Blob([Buffer.from([0,1,2,255])]),'ref.png');
  const pending=s.request('http://127.0.0.1:8787/api/v1/video/generate',{method:'POST',body:form});
  await new Promise(r=>setImmediate(r));
  const {job}=s.bridge.take(1,'client-a');assert(job);
  const seen=[];
  const result=await executeJob({localOrigin:s.config.base_url},job,async()=>s.bridge.permitted(s.auth,job.id,'client-a'),undefined,async(url,options)=>{
    seen.push(url);const req=new Request(url,options),data=await req.formData();assert.equal(data.get('prompt'),'test scene');assert.deepEqual(Buffer.from(await data.get('files').arrayBuffer()),Buffer.from([0,1,2,255]));
    return new Response(JSON.stringify({request_id:'job-1'}),{status:202});
  });
  assert.equal(s.bridge.result({...s.auth,organization_id:20},job.id,'client-a',result),false);
  assert.equal(s.bridge.result(s.auth,job.id,'other-client',result),false);
  assert.equal(s.bridge.result(s.auth,job.id,'client-a',result),true);
  assert.equal((await(await pending).json()).request_id,'job-1');assert.equal(seen.length,1);
  const waiting=s.request('http://127.0.0.1:8787/api/v1/video/jobs/job-1');
  const rejected=assert.rejects(waiting,/已关闭/);await new Promise(r=>setImmediate(r));
  s.bridge.setEnabled(1,10,1,false);await rejected;assert.equal(s.bridge.jobs.size,0);assert.equal(s.bridge.bytes,0);
  assert.equal(s.bridge.permitted(s.auth,job.id,'client-a'),false);
});
test('connector refuses arbitrary LAN targets, other interfaces, traversal and revoked jobs before any local fetch',async()=>{
  assert.throws(()=>localOrigin('http://192.168.0.1:80'),/仅支持/);
  for(const route of ['/api/v1/accounts','/api/v1/video/jobs','//evil.test/','/api/v1/video/jobs/a/../accounts','/api/v1/video/jobs/a?redirect=x'])assert.equal(allowedRequest('GET',route),false);
  let called=0;const fetcher=async()=>{called++;return new Response('{}')};
  await assert.rejects(executeJob({localOrigin:'http://127.0.0.1:8787'},{method:'GET',path:'/api/v1/accounts'},async()=>true,null,fetcher),/之外/);
  await assert.rejects(executeJob({localOrigin:'http://127.0.0.1:8787'},{method:'GET',path:'/health'},async()=>false,null,fetcher),/关闭/);
  await assert.rejects(executeJob({localOrigin:'http://192.168.0.1'},{method:'GET',path:'/health'},async()=>true,null,fetcher),/地址/);
  assert.equal(called,0);
});
test('HTTP endpoints require scoped connector tokens and owner permission; toggle wakes long poll',async t=>{
  const s=setup(t),app=express();app.use('/bridge',transport(s.bridge));app.use(express.json());
  app.use((req,res,next)=>{req.user={id:1,role:req.headers['x-role']||'member',organization:{id:10}};next();});
  management(app,s.bridge);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  const base='http://127.0.0.1:'+server.address().port,body={clientId:'12345678-1234-1234-1234-123456789abc'};
  assert.equal((await fetch(base+'/bridge/poll',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})).status,401);
  const options={method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})};
  assert.equal((await fetch(base+'/ai-configs/1/local-access',options)).status,403);
  options.headers['x-role']='owner';assert.equal((await fetch(base+'/ai-configs/1/local-access',options)).status,200);
  const res=await fetch(base+'/bridge/poll',{method:'POST',headers:{'content-type':'application/json',Authorization:'Bearer '+s.pairing.token},body:JSON.stringify(body)});assert.equal((await res.json()).enabled,true);
  assert.equal((await fetch(base+'/ai-configs/1/local-access')).status,200);
});
