const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const service = require('../src/services/dramaService');
const planner = require('../src/services/narrativeUnitPlanner');
const log = { info() {}, error() {}, warn() {} };
const Database = require('better-sqlite3');
const ai = require('../src/services/aiClient');
const { runMigrationsAndEnsure } = require('../src/db/migrate');
function database(script) {
  const db = new Database(':memory:'); runMigrationsAndEnsure(db);
  db.prepare("INSERT INTO dramas(id,title,metadata,created_at,updated_at) VALUES(1,'验收','{}','now','now')").run();
  db.prepare("INSERT INTO episodes(id,drama_id,episode_number,title,script_content,created_at,updated_at) VALUES(1,1,1,'验收',?,'now','now')").run(script);
  db.prepare("INSERT INTO ai_service_configs(id,service_type,provider,api_protocol,name,base_url,api_key,model,default_model,is_default,is_active,settings,created_at,updated_at) VALUES(1,'video','doubao_manager','doubao_manager','验收','http://127.0.0.1:9','','[\"用户30秒模型\"]','用户30秒模型',1,1,?,'now','now')").run(JSON.stringify({video_duration:{mode:'range',min_seconds:4,max_seconds:30,step_seconds:1}}));
  return db;
}
const state = () => Object.fromEntries(planner.STATE_KEYS.map(key => [key, '现场状态：无变化对象明确不适用']));
const unit = ids => ({ main_arc: '原文动作完成', auxiliary_modes: [], space_type: 'A_CONTINUOUS', initial_state: state(), final_state: state(), event_ids: ids,
  closure: { event_id: ids.at(-1), narrative: true, visual: true, reason: '观众看见动作完成后的稳定结果' } });
const action = (id, source, duration = 20000, deps = []) => ({ id, kind: 'result', description: '原文动作完成', duration_ms: duration, depends_on: deps, resources: ['人物.双腿'], source_ids: [source], must_complete_with: [] });
const approvedClosures = input => JSON.stringify({ boundaries: input.closure_checks.map(row => ({ unit: row.unit, closed: true, reason: '本测试原文中的动作或回答已完整结束' })) });

test('HTTP preserves automatic versus manual settings and all planning choices', async t => {
  let captured;
  t.mock.method(service, 'generateStoryboard', (_db, _log, _id, options) => { captured = options; return { task_id: 'local-test' }; });
  const app = express(); app.use(express.json());
  app.post('/generate', require('../src/routes/drama')({}, {}, log).generateStoryboard);
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const input = { storyboard_count: 5, storyboard_count_source: 'auto', video_duration: 146, video_duration_source: 'auto',
    video_clip_duration: 30, video_clip_duration_mode: 'target', universal_omni_storyboard: true,
    include_narration: false, storyboard_use_first_last_frame: false, sequence_mode: 'single', language: 'zh', aspect_ratio: '16:9', style: '东方玄幻' };
  const res = await fetch(`http://127.0.0.1:${server.address().port}/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(res.status, 200);
  for (const [key, value] of Object.entries(input)) assert.equal(captured[key], value, key);
});

test('automatic estimates never become manual budgets and target mode is retained', () => {
  const out = planner.planningSettings({ clip_seconds: 30, duration_mode: 'target', storyboard_count: 5, storyboard_count_source: 'auto', total_seconds: 146, total_source: 'auto' });
  assert.equal(out.duration_mode, 'target'); assert.equal(out.manual_count, null); assert.equal(out.manual_total_seconds, null);
  const manual = planner.planningSettings({ ...out, storyboard_count_source: 'manual', total_source: 'manual' });
  assert.equal(manual.manual_count, 5); assert.equal(manual.manual_total_seconds, 146);
});

test('dialogue lower bound and linked listener are repaired without changing words', () => {
  const result = planner.normalizeEvents([
    { id: 'e6', kind: 'dialogue', speaker: '女儿', dialogue: '我走了，你一个人也能过得挺好吧？', duration_ms: 800, depends_on: [], resources: ['女儿.声音'], source_ids: ['S1'], must_complete_with: [] },
    { id: 'e7', kind: 'reaction', duration_ms: 300, depends_on: ['e6'], resources: ['父亲.视线'], source_ids: ['S2'], must_complete_with: [] },
  ]);
  assert.equal(result.events[0].duration_ms, 2800);
  assert.deepEqual(result.events[0].must_complete_with, ['e7']);
  assert.equal(result.events[0].dialogue, '我走了，你一个人也能过得挺好吧？');
  assert.equal(result.corrections.length, 2);
});

test('source segmentation preserves text offsets and works across action line wrapping', () => {
  for (const text of ['△他走到门口。△他站稳。\n女儿：你回来吗？', '△他走到门口。\n△他站稳。\n女儿：你回来吗？']) {
    const source = planner.sourceSegments(text);
    assert.equal(source.length, 3);
    for (const s of source) assert.equal(text.slice(s.char_start, s.char_end), s.text);
    assert.equal(source.at(-1).dialogue, '你回来吗？');
  }
});

test('manual count and total conflicts are found before any model call', () => {
  const settings = planner.planningSettings({ clip_seconds: 30, storyboard_count: 4, storyboard_count_source: 'manual', total_seconds: 180, total_source: 'manual' });
  const errors = planner.settingsIssues(settings, { mode: 'fixed', allowed_seconds: [15, 30] });
  assert.ok(errors.some(e => /120/.test(e.message)));
});

test('multi-unit allocation repairs an overloaded scene once and records frozen automatic settings', async t => {
  const db = database('△他走到门口。\n△他走下楼并站稳。'); t.after(() => db.close());
  let calls = 0;
  t.mock.method(ai, 'generateText', async (_db, _log, _type, user, system) => {
    const input = JSON.parse(user); calls++;
    assert.equal(input.settings.duration_mode, 'target'); assert.equal(input.settings.manual_count, null);
    if (input.closure_checks) return approvedClosures(input);
    if (calls === 1) { assert.match(system, /不要求整篇在段容量内/); return JSON.stringify({ events: [action('a', 'S1'), action('b', 'S2', 20000, ['a'])] }); }
    if (calls === 2) return JSON.stringify({ units: [unit(['a', 'b'])] });
    assert.ok(input.issues.some(e => /40 秒超过容量/.test(e.message)));
    return JSON.stringify({ units: [unit(['a']), unit(['b'])] });
  });
  const out = await planner.generate(db, log, 1, undefined, 30, null, { duration_mode: 'target', storyboard_count: 5, storyboard_count_source: 'auto', total_seconds: 146, total_source: 'auto' });
  assert.equal(calls, 4); assert.equal(out.repair_count, 1); assert.equal(out.units.length, 2);
  assert.deepEqual(out.units.map(u => u.request_duration_ms), [20000, 20000]);
  assert.equal(out.settings.total_source, 'auto'); assert.equal(out.total_request_seconds, 40);
  assert.equal(db.prepare('SELECT status FROM narrative_unit_plans').get().status, 'validated');
});

test('malformed allocation repair arrays preserve the last valid draft instead of emptying units', async t => {
  const db = database('△甲推出一掌，气浪撞向父亲。'); t.after(() => db.close());
  let closureChecks = 0, repairs = 0;
  t.mock.method(ai, 'generateText', async (_db, _log, _type, user) => {
    const input = JSON.parse(user);
    if (input.closure_checks) {
      closureChecks++;
      return JSON.stringify({ boundaries: [{ unit: 1, closed: false, reason: '攻击已发出但尚无命中或防御结果' }] });
    }
    if (input.reviewed_units) { repairs++; return JSON.stringify([unit(['attack'])]); }
    if (input.source_segments && !input.events) return JSON.stringify({ events: [action('attack', 'S1', 15000)] });
    return JSON.stringify({ units: [unit(['attack'])] });
  });
  await assert.rejects(planner.generate(db, log, 1, undefined, 30, null, {}), /定向修正必须返回JSON对象/);
  const saved = db.prepare('SELECT * FROM narrative_unit_plans').get(), report = JSON.parse(saved.payload);
  assert.equal(saved.status, 'blocked');
  assert.equal(report.units.length, 1);
  assert.deepEqual(report.units[0].events.slice(1).map(e => e.id), ['attack']);
  assert.equal(repairs, 2); assert.equal(closureChecks, 1);
  assert.ok(report.issues.some(e => /定向修正必须返回JSON对象/.test(e.message)));
});

test('unrepairable inventory stops after two repairs and saves actionable report', async t => {
  const db = database('父亲：不要走。'); t.after(() => db.close()); let calls = 0;
  t.mock.method(ai, 'generateText', async () => { calls++; return '{"events":[]}'; });
  await assert.rejects(planner.generate(db, log, 1, undefined, 30, null, {}), /没有返回事件清单/);
  assert.equal(calls, 3);
  const saved = db.prepare('SELECT * FROM narrative_unit_plans').get(), report = JSON.parse(saved.payload);
  assert.equal(saved.status, 'blocked'); assert.equal(report.repair_count, 2); assert.equal(report.attempts.length, 3);
});

test('manual impossible budgets fail without making an AI request', async t => {
  const db = database('△他站稳。'); t.after(() => db.close()); let calls = 0;
  t.mock.method(ai, 'generateText', async () => { calls++; throw Error('must not call'); });
  await assert.rejects(planner.generate(db, log, 1, undefined, 30, 4, { total_seconds: 180, total_source: 'manual' }), /最多 120 秒/);
  assert.equal(calls, 0);
});

test('manual total mismatch remains visible even if each unit individually fits', async t => {
  const db = database('△他走到门口。\n△他走下楼并站稳。'); t.after(() => db.close()); let calls = 0;
  t.mock.method(ai, 'generateText', async () => {
    calls++;
    return JSON.stringify(calls === 1 ? { events: [action('a', 'S1'), action('b', 'S2', 20000, ['a'])] } : { units: [unit(['a']), unit(['b'])] });
  });
  await assert.rejects(planner.generate(db, log, 1, undefined, 30, 2, { total_seconds: 30, total_source: 'manual' }), /人工指定总时长 30 秒/);
  assert.equal(calls, 4);
});

test('reply or explicit action may serve as response but unrelated IDs do not pass', () => {
  const spoken = { id: 'a', kind: 'dialogue', speaker: '甲', dialogue: '拿着。', duration_ms: 2000, depends_on: [], resources: ['甲.声音'], source_ids: ['S1'], must_complete_with: [] };
  const reply = { ...spoken, id: 'b', speaker: '乙', dialogue: '好。', depends_on: ['a'], source_ids: ['S2'] };
  assert.deepEqual(planner.normalizeEvents([spoken, reply]).events[0].must_complete_with, ['b']);
  const unrelated = { ...action('b', 'S2'), depends_on: [] };
  const events = [{ ...spoken, must_complete_with: ['b'] }, unrelated];
  const errors = planner.inventoryIssues(events, planner.sourceSegments('甲：拿着。\n△乙站着。'), planner);
  assert.ok(errors.some(e => e.code === 'response_dependency'));
});

test('targeted repair retains correct events and units and answers terminate response chains', () => {
  const initial = [action('a', 'S1'), action('b', 'S2')];
  const patched = planner.mergeEventRepair(initial, { events: [{ ...initial[1], duration_ms: 25000 }] });
  assert.deepEqual(patched.events[0], initial[0]); assert.equal(patched.events.length, 2);
  const first = unit(['a']), second = unit(['b', 'c']);
  const allocation = planner.mergeAllocationRepair({ units: [first, second] }, { unit_replacements: [{ index: 2, units: [unit(['b']), unit(['c'])] }] });
  assert.deepEqual(allocation.units[0], first); assert.equal(allocation.units.length, 3);
  const events = [
    { ...action('q', 'S1', 2000), kind: 'dialogue', speaker: '甲', dialogue: '好吗？', must_complete_with: ['a'] },
    { ...action('a', 'S2', 1000, ['q']), kind: 'dialogue', speaker: '乙', dialogue: '好。', responds_to: 'q' },
  ];
  assert.deepEqual(planner.inventoryIssues(events, planner.sourceSegments('甲：好吗？\n乙：好。'), planner), []);
});

test('real HTTP job sends target settings directly without requiring a validated plan', async t => {
  const db = database('△他走到门口并站稳。'); t.after(() => db.close());
  planner.init(db);
  db.prepare('UPDATE dramas SET metadata=? WHERE id=1').run(JSON.stringify({video_clip_duration:30,video_clip_duration_mode:'target'}));
  let generationCalls = 0;
  t.mock.method(ai, 'generateText', async (_db, _log, _kind, user) => {
    generationCalls++;
    assert.match(user, /"duration_mode":"target"/);
    assert.doesNotMatch(user, /"attempts":|"timing_candidates":/);
    assert.doesNotMatch(user, /已验证单元计划/);
    return JSON.stringify([{shot_number:1,title:'到门口',duration:26,action:'他走到门口并站稳。',dialogue:'',result:'站稳',characters:[]}]);
  });
  const app=express();app.use(express.json());app.post('/episodes/:episode_id/storyboards',require('../src/routes/drama')(db,{},log).generateStoryboard);
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}/episodes/1/storyboards`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({storyboard_count:5,storyboard_count_source:'auto',video_duration:146,video_duration_source:'auto',video_clip_duration:30,video_clip_duration_mode:'target',include_narration:false,universal_omni_storyboard:false})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));
  let task;
  for(let i=0;i<100;i++){task=db.prepare('SELECT * FROM async_tasks WHERE id=?').get(body.data.task_id);if(['completed','failed'].includes(task.status))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(task.status,'completed',task.error);
  assert.equal(generationCalls,1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM narrative_unit_plans').get().n,0);
  assert.equal(db.prepare('SELECT duration FROM storyboards WHERE deleted_at IS NULL').get().duration,30);
});

test('oversized artificial lock chains are diagnosed before allocation without deleting real locks', () => {
  const sources = planner.sourceSegments('△他迈步。△他停稳。△他开门。△门后的人走出。');
  const events = sources.map((s, i) => ({ ...action(`a${i}`, s.id, 10000, i ? [`a${i - 1}`] : []), must_complete_with: i < 3 ? [`a${i + 1}`] : [] }));
  const settings = planner.planningSettings({ clip_seconds: 30 });
  assert.ok(planner.inventoryIssues(events, sources, planner, settings).some(e => e.code === 'indivisible_capacity' && /40 秒/.test(e.message)));
  const patched = planner.mergeEventRepair(events, { events: [{ id: 'a1', must_complete_with: [] }] }).events;
  assert.equal(patched[1].description, events[1].description);
  const candidates = planner.timingCandidates(patched, sources, settings, { mode: 'range', min: 4, max: 30, step: 1 }, planner);
  assert.deepEqual(candidates.boundary_after, ['a1', 'a3']);
  assert.deepEqual(candidates.suggested_ranges.map(r => r.estimated_ms), [20000, 20000]);
  assert.deepEqual(patched[0].must_complete_with, ['a1']);
  assert.deepEqual(patched[2].must_complete_with, ['a3']);
});

test('a reply after an existing listener action ends the response chain and unrelated replies do not', () => {
  const events = [
    { ...action('q', 'S1', 2000), kind: 'dialogue', speaker: '甲', dialogue: '还算数吗？', must_complete_with: ['nod'] },
    { ...action('nod', 'S2', 1000, ['q']), kind: 'reaction', must_complete_with: ['reply'] },
    { ...action('reply', 'S3', 1000, ['nod']), kind: 'dialogue', speaker: '乙', dialogue: '算。', responds_to: 'q' },
  ];
  const sources = planner.sourceSegments('甲：还算数吗？\n△乙点头。\n乙：算。');
  assert.equal(planner.isDialogueReply(events[2], events), true);
  assert.deepEqual(planner.inventoryIssues(events, sources, planner, planner.planningSettings({ clip_seconds: 30 })), []);
  const review = planner.reviewUnits(planner.assembleUnits({ units: [unit(['q', 'nod', 'reply'])] }, events), sources, sources.map(s => s.text).join(''), planner.planningSettings({ clip_seconds: 30 }), { mode: 'range', min: 4, max: 30, step: 1 }, planner);
  assert.deepEqual(review.issues, []);
  events[1].must_complete_with = [];
  assert.equal(planner.isDialogueReply(events[2], events), false);
});

test('dialogue-only exchanges need no fabricated extra reaction and inverse response links remain causal', () => {
  const script = '甲：你愿意吗？\n乙：我愿意。', sources = planner.sourceSegments(script);
  const events = planner.normalizeEvents([
    { ...action('q', 'S1', 2000), kind: 'dialogue', speaker: '甲', dialogue: '你愿意吗？' },
    { ...action('a', 'S2', 2000, ['q']), kind: 'dialogue', speaker: '乙', dialogue: '我愿意。', responds_to: 'q' },
  ]).events;
  const settings = planner.planningSettings({ clip_seconds: 30 });
  const review = planner.reviewUnits(planner.assembleUnits({ units: [unit(['q', 'a'])] }, events), sources, script, settings, { mode: 'range', min: 4, max: 30, step: 1 }, planner);
  assert.deepEqual(review.issues, []);
  events[1].depends_on = [];
  assert.ok(planner.inventoryIssues(events, sources, planner, settings).some(e => e.code === 'response_dependency'));
});

test('listener response across intervening self action is found but branching tracks are not guessed', () => {
  const spoken = { ...action('talk', 'S1', 2000), kind: 'dialogue', speaker: '女儿', dialogue: '我长大了。' };
  const effect = { ...action('light', 'S2', 1000, ['talk']), kind: 'effect', resources: ['女儿.双手'] };
  const reaction = { ...action('smile', 'S3', 1000, ['light']), kind: 'reaction', resources: ['父亲.面部'] };
  const out = planner.normalizeEvents([spoken, effect, reaction]);
  assert.deepEqual(out.events[0].must_complete_with, ['smile']);
  assert.equal(out.events.length, 3);
  const ambiguous = planner.normalizeEvents([spoken, effect, reaction, { ...action('other', 'S4', 1000, ['talk']), resources: ['哥哥.双手'] }]);
  assert.deepEqual(ambiguous.events[0].must_complete_with, []);
});

test('same-speaker continuation lines share the existing listener response and either link direction is accepted', () => {
  const events = planner.normalizeEvents([
    { ...action('a', 'S1', 2000), kind: 'dialogue', speaker: '女儿', dialogue: '我想离开。' },
    { ...action('b', 'S2', 2000, ['a']), kind: 'dialogue', speaker: '女儿', dialogue: '可我舍不得你。' },
    { ...action('c', 'S3', 1000, ['b']), kind: 'reaction', resources: ['父亲.面部'] },
  ]).events;
  assert.deepEqual(events[0].must_complete_with, ['c']); assert.deepEqual(events[1].must_complete_with, ['c']);
  const reply = { ...action('answer', 'S4', 2000, ['a']), kind: 'dialogue', speaker: '父亲', dialogue: '我明白。' };
  assert.equal(planner.isDialogueReply(reply, [{ ...events[0], must_complete_with: ['answer'] }, reply]), true);
});

test('candidate timing uses parallel critical paths and preserves same-source semantics', () => {
  const sources = planner.sourceSegments('△她走向门口，听到脚步后站稳。');
  const events = [action('walk', 'S1', 10000), { ...action('sound', 'S1', 4000), resources: ['门外.声音'] }, action('result', 'S1', 1000, ['walk', 'sound'])];
  const out = planner.timingCandidates(events, sources, planner.planningSettings({ clip_seconds: 30 }), { mode: 'range', min: 4, max: 30, step: 1 }, planner);
  assert.deepEqual(out.boundary_after, ['result']);
  assert.equal(out.suggested_ranges[0].estimated_ms, 11000);
  assert.equal(out.suggested_ranges[0].performance_gap_ms, 0);
});

test('fixed-slot candidates expose performance gaps without silently padding natural closure', () => {
  const events = [action('a', 'S1', 26000)], sources = planner.sourceSegments('△她完成检查后站稳。');
  const out = planner.timingCandidates(events, sources, planner.planningSettings({ clip_seconds: 30 }), { mode: 'fixed', allowed_seconds: [15, 30] }, planner);
  assert.equal(out.suggested_ranges[0].performance_gap_ms, 3000);
  const review = planner.reviewUnits(planner.assembleUnits({ units: [unit(['a'])] }, events), sources, sources[0].text, planner.planningSettings({ clip_seconds: 30 }), { mode: 'fixed', allowed_seconds: [15, 30] }, planner);
  assert.ok(review.issues.some(e => /不能硬填/.test(e.message)));
});

test('model context bounds redundant alternatives while retaining all legal boundaries and full diagnostics', () => {
  const sources = planner.sourceSegments(Array.from({ length: 12 }, (_, i) => `△人物完成第${i + 1}个动作。`).join('\n'));
  const events = sources.map((s, i) => action(`e${i}`, s.id, 5000, i ? [`e${i - 1}`] : []));
  const full = planner.timingCandidates(events, sources, planner.planningSettings({ clip_seconds: 30 }), { mode: 'fixed', allowed_seconds: [15, 30] }, planner);
  const context = planner.candidateContext(full);
  assert.deepEqual(context.boundary_after, full.boundary_after);
  assert.deepEqual(context.suggested_ranges, full.suggested_ranges);
  assert.ok(context.ranges.length <= full.suggested_ranges.length * 4);
  assert.ok(full.ranges.length > context.ranges.length);
});

test('semantic boundary review repairs an attack separated from defense despite valid timing', async t => {
  const db = database('△甲发出攻击。\n△乙格挡后站稳。\n△甲离开院子。'); t.after(() => db.close());
  const events = [action('attack', 'S1', 20000), action('defend', 'S2', 10000, ['attack']), action('leave', 'S3', 20000, ['defend'])];
  let reviews = 0;
  t.mock.method(ai, 'generateText', async (_db, _log, _kind, user) => {
    const input = JSON.parse(user);
    if (input.closure_checks) {
      reviews++;
      if (reviews === 1) {
        assert.equal(input.closure_checks[0].next_events[0].id, 'defend');
        return JSON.stringify({ boundaries: [{ unit: 1, closed: false, reason: '攻击尚未被格挡，防御留在了下一段' }, { unit: 2, closed: true, reason: '已离开院子' }] });
      }
      return approvedClosures(input);
    }
    if (!input.events) return JSON.stringify({ events });
    if (input.issues) {
      assert.ok(input.issues.some(e => e.code === 'semantic_closure'));
      return JSON.stringify({ units: [unit(['attack', 'defend']), unit(['leave'])] });
    }
    return JSON.stringify({ units: [unit(['attack']), unit(['defend', 'leave'])] });
  });
  const out = await planner.generate(db, log, 1, undefined, 30, null, {});
  assert.equal(out.repair_count, 1); assert.equal(reviews, 2);
  assert.deepEqual(out.units[0].events.slice(1).map(e => e.id), ['attack', 'defend']);
  assert.equal(out.units[0].request_duration_ms, 30000);
  assert.equal(planner.closureReviewIssues({ boundaries: [] }, 2).length, 2);
});

test('continuous handoff copies all explicit fields while narrative jump keeps its own entry', () => {
  const first = unit(['a']), second = unit(['b']), third = { ...unit(['c']), space_type: 'C_NARRATIVE_JUMP', transition_reason: '原文次日', initial_state: { ...state(), world_position: '次日院外' } };
  first.final_state.world_position = '门口内侧'; second.initial_state.world_position = '模型换了一种说法';
  const out = planner.assembleUnits({ units: [first, second, third] }, [action('a', 'S1'), action('b', 'S2'), action('c', 'S3')]);
  assert.deepEqual(out[1].initial_state, first.final_state);
  assert.equal(out[2].initial_state.world_position, '次日院外');
  assert.equal(second.initial_state.world_position, '模型换了一种说法');
});

test('ellipsis dialogue has the same speed floor in inventory and final plan validation', () => {
  const script = '甲：我……明白。\n△乙点头。';
  const sources = planner.sourceSegments(script), events = planner.normalizeEvents([
    { ...action('d', 'S1', 100), kind: 'dialogue', speaker: '甲', dialogue: '我……明白。', must_complete_with: ['r'] },
    { ...action('r', 'S2', 3400, ['d']), kind: 'reaction' },
  ]).events;
  const out = planner.reviewUnits(planner.assembleUnits({ units: [unit(['d', 'r'])] }, events), sources, script, planner.planningSettings({ clip_seconds: 30 }), { mode: 'range', min: 4, max: 30, step: 1 }, planner);
  assert.deepEqual(out.issues, []);
  assert.equal(out.units[0].request_duration_ms, 4000);
});

test('dialogue-heavy and action-heavy scripts retain coverage across CRLF and same-scene segments', async t => {
  for (const separator of ['\n', '\r\n']) {
    const script = ['甲：等我回来。', '乙：好。', '△甲走出院门后站稳。', '△乙走到窗前后站稳。'].join(separator);
    const db = database(script);
    const events = [
      { ...action('q', 'S1', 3000), kind: 'dialogue', speaker: '甲', dialogue: '等我回来。', must_complete_with: ['reply'] },
      { ...action('reply', 'S2', 1000, ['q']), kind: 'dialogue', speaker: '乙', dialogue: '好。', responds_to: 'q' },
      action('walk', 'S3', 16000, ['reply']), action('window', 'S4', 20000, ['walk']),
    ];
    let calls = 0;
    const mocked = t.mock.method(ai, 'generateText', async (_db, _log, _kind, user) => {
      const input = JSON.parse(user);
      if (input.closure_checks) return approvedClosures(input);
      return JSON.stringify(++calls === 1 ? { events } : { units: [unit(['q', 'reply', 'walk']), unit(['window'])] });
    });
    try {
      const out = await planner.generate(db, log, 1, undefined, 30, 2, { duration_mode: 'capacity', total_seconds: 40, total_source: 'manual' });
      assert.equal(out.repair_count, 0); assert.equal(out.units.length, 2); assert.equal(out.total_request_seconds, 40);
      assert.deepEqual(out.units.flatMap(u => u.events).filter(e => e.kind === 'dialogue').map(e => e.dialogue), ['等我回来。', '好。']);
    } finally { mocked.mock.restore(); db.close(); }
  }
});
