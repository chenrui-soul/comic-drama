const { test }=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const Database=require('better-sqlite3');
const {runMigrationsAndEnsure}=require('../src/db/migrate');
const skills=require('../src/services/creativeSkillPacks');
const log={info(){},warn(){},error(){},debug(){}};
test('missing Skill references block binding and explicit module map routes only matching files',t=>{
  const db=new Database(':memory:');runMigrationsAndEnsure(db);t.after(()=>db.close());
  db.prepare("INSERT INTO dramas(id,title,created_at,updated_at) VALUES(1,'测试','now','now')").run();
  const bad=skills.save(db,{kind:'asset',files:[{path:'SKILL.md',content:'使用 [规则](rules/missing.md)'}]});
  assert.equal(bad.compatibility.errors.length,1);assert.throws(()=>skills.setSettings(db,1,{asset_pack_id:bad.id}),/SKILL_INCOMPATIBLE/);
  const pack=skills.save(db,{kind:'asset',files:[{path:'SKILL.md',content:'入口'},{path:'rules/role.md',content:'人物独有规则'},{path:'rules/scene.md',content:'场景独有规则'},{path:'rules/prop.md',content:'道具独有规则'},{path:'platform-adapter.json',content:JSON.stringify({modules:{character_image_prompt:['rules/role.md'],scene_image_prompt:['rules/scene.md'],prop_image_prompt:['rules/prop.md']}})}]});
  skills.setSettings(db,1,{asset_pack_id:pack.id});
  const prompt=skills.getModulePrompt(db,1,'prop_image_prompt');assert.match(prompt,/道具独有规则/);assert.doesNotMatch(prompt,/人物独有规则|场景独有规则/);
});
test('local reference content changes are detected without modifying source files',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'drama-reference-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  t.mock.method(require('../src/config'),'loadConfig',()=>({storage:{local_path:dir,base_url:'http://localhost:5680/static'}}));
  const snap=require('../src/services/videoReferenceSnapshot');fs.writeFileSync(path.join(dir,'ref.png'),'original');
  const refs=snap.capture(['/static/ref.png']);snap.verify(refs);
  fs.writeFileSync(path.join(dir,'ref.png'),'changed');assert.throws(()=>snap.verify(refs),/已变化/);
});
test('startup orphan sweep leaves active videos to the recovery owner',t=>{
  const db=new Database(':memory:');runMigrationsAndEnsure(db);t.after(()=>db.close());
  const tasks=require('../src/services/taskService');
  db.prepare("INSERT INTO dramas(id,title,created_at,updated_at) VALUES(1,'测试','now','now')").run();
  const active=tasks.createTask(db,log,'video_generation','1'),orphan=tasks.createTask(db,log,'video_generation','1');
  db.prepare("INSERT INTO video_generations(drama_id,provider,prompt,status,task_id,provider_task_id,created_at,updated_at) VALUES(1,'test','测试','processing',?,'remote-id','now','now')").run(active.id);
  assert.equal(tasks.failOrphanedAsyncTasksOnStartup(db,log),1);
  assert.equal(tasks.getTask(db,active.id).status,'pending');assert.equal(tasks.getTask(db,orphan.id).status,'failed');
});
