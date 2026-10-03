const crypto = require('crypto');
const ai = require('./aiClient');
const video = require('./videoClient');
const { safeParseAIJSON } = require('../utils/safeJson');
const { getTenantId } = require('../utils/tenantContext');

const issue = (code, message, unit = null, event = null) => ({ code, message, unit, event });
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
function planningSettings(input = {}) {
  const count = positive(input.storyboard_count), total = positive(input.total_seconds);
  const countSource = input.storyboard_count_source || (count ? 'manual' : 'auto');
  const totalSource = input.total_source || (total ? 'manual' : 'auto');
  return { ...input, clip_seconds: positive(input.clip_seconds) || 30,
    duration_mode: input.duration_mode === 'capacity' ? 'capacity' : 'target',
    storyboard_count: count, storyboard_count_source: countSource, manual_count: countSource === 'manual' ? count : null,
    total_seconds: total, total_source: totalSource, manual_total_seconds: totalSource === 'manual' ? total : null,
    total_tolerance_seconds: 1 };
}
function legalSeconds(settings, cap) {
  if (cap.mode === 'invalid') return [];
  if (cap.mode === 'fixed') return cap.allowed_seconds.filter(s => s <= settings.clip_seconds);
  const seconds = [];
  for (let s = cap.min; s <= Math.min(cap.max, settings.clip_seconds); s += cap.step || 1) seconds.push(s);
  return seconds;
}
function settingsIssues(settings, cap) {
  const errors = [], legal = legalSeconds(settings, cap), n = settings.manual_count, total = settings.manual_total_seconds;
  if (!legal.length) errors.push(issue('channel_capacity', `所选每段 ${settings.clip_seconds} 秒范围内没有通道支持的时长档位`));
  if (n && (!Number.isInteger(n) || n > 200)) errors.push(issue('count', '人工单元数量必须为 1～200 的整数'));
  if (total && total > 600) errors.push(issue('total', '本入口整集总时长须在 600 秒以内'));
  if (n && total && legal.length) {
    const min = Math.min(...legal) * n, max = Math.max(...legal) * n;
    if (total < min - 1 || total > max + 1) errors.push(issue('budget', `人工要求 ${n} 段、总计 ${total} 秒，但当前档位最多 ${max} 秒、最少 ${min} 秒；请调整数量或总时长`));
    else {
      let possible = new Set([0]);
      for (let i = 0; i < n; i++) possible = new Set([...possible].flatMap(sum => legal.map(s => sum + s)).filter(s => s <= total + 1));
      if (![...possible].some(s => Math.abs(s - total) <= 1)) errors.push(issue('budget_slots', `人工要求的 ${n} 段无法用通道档位组合到 ${total} 秒（允许 1 秒误差），请调整设置`));
    }
  }
  return errors;
}

// Positions are UTF-16 character offsets, never seconds. Split action sentences, not dialogue semantics.
function sourceSegments(script) {
  const sources = [], text = String(script);
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const speaker = line.trim().match(/^([\p{L}\p{N}_·（）() ]{1,24})[：:]\s*(.+)$/u);
    const isDialogue = speaker && !/^(场景|时间|地点|人物|画面|动作|音效|标题|Scene|Time|Location)$/i.test(speaker[1]);
    const heading = /^\s*(《[^》]+》|\d+[．.、].*[／/]|第.+[场幕集])/u.test(line);
    const pieces = isDialogue || heading ? [line] : line.match(/[^。！？\n]+[。！？]?\s*|\n/g) || [line];
    let local = offset;
    for (const piece of pieces) {
      if (piece.trim()) sources.push({ id: `S${sources.length + 1}`, char_start: local, char_end: local + piece.length,
        text: piece, kind: isDialogue ? 'dialogue' : heading ? 'heading' : 'action',
        ...(isDialogue ? { speaker: speaker[1].trim(), dialogue: speaker[2] } : {}) });
      local += piece.length;
    }
    offset += line.length;
  }
  return sources;
}
function dialogueMinimum(text) {
  return Math.ceil([...String(text || '').replace(/[\s，。！？、；：,.!?;:“”「」…]/g, '')].length / 5 * 1000);
}
function isDialogueReply(event, events) {
  const byId = new Map(events.map(e => [e.id, e]));
  const parents = events.filter(e => e.kind === 'dialogue' && e.speaker !== event.speaker &&
    (event.responds_to ? e.id === event.responds_to : e.must_complete_with?.includes(event.id)));
  const pending = parents.flatMap(e => e.must_complete_with || []), visited = new Set();
  while (pending.length) {
    const id = pending.pop();
    if (id === event.id) return true;
    if (visited.has(id)) continue;
    visited.add(id); pending.push(...(byId.get(id)?.must_complete_with || []));
  }
  return false;
}
function normalizeEvents(input) {
  const events = structuredClone(Array.isArray(input) ? input : []).map(e => e && typeof e === 'object' && !Array.isArray(e) ? e : {}), corrections = [];
  for (const e of events) if (!Array.isArray(e.must_complete_with)) e.must_complete_with = [];
  // The schema allows either side to declare a response. Canonicalize explicit
  // declarations first; the inventory validator still proves causal dependency.
  for (const response of events) {
    const parent = events.find(e => e.id === response.responds_to && e.id !== response.id);
    if (parent && !parent.must_complete_with.includes(response.id)) {
      parent.must_complete_with.push(response.id);
      corrections.push({ event: parent.id, message: `将已有回应 ${response.id} 的 responds_to 关联同步到 ${parent.id}` });
    }
  }
  for (const e of events) {
    if (e.kind !== 'dialogue') continue;
    const min = dialogueMinimum(e.dialogue);
    if (Number.isFinite(e.duration_ms) && e.duration_ms < min) {
      corrections.push({ event: e.id, message: `对白 ${e.id} 从 ${e.duration_ms / 1000} 秒修正至语速下限 ${min / 1000} 秒；台词保持原文` });
      e.duration_ms = min;
    }
    if (e.must_complete_with.length || isDialogueReply(e, events)) continue;
    let cursor = e, listener = null;
    const visited = new Set([e.id]);
    while (cursor) {
      const following = events.filter(next => Array.isArray(next.depends_on) && next.depends_on.includes(cursor.id));
      if (following.length !== 1 || visited.has(following[0].id)) break;
      const next = following[0]; visited.add(next.id);
      const actor = typeof next.resources?.[0] === 'string' ? next.resources[0].split('.')[0] : null;
      if ((next.kind === 'dialogue' && next.speaker && next.speaker !== e.speaker) ||
          (['reaction', 'action', 'result'].includes(next.kind) && actor && next.resources[0].includes('.') && actor !== e.speaker)) { listener = next; break; }
      // Consecutive lines by the same speaker share the eventual listener response;
      // a sound/camera/unknown track does not establish that relationship.
      if ((next.kind === 'dialogue' && next.speaker !== e.speaker) || !['dialogue', 'action', 'effect', 'reaction', 'result'].includes(next.kind)) break;
      cursor = next;
    }
    if (listener) {
      e.must_complete_with = [listener.id];
      if (listener.kind === 'dialogue' && !listener.responds_to) listener.responds_to = e.id;
      corrections.push({ event: e.id, message: `对白 ${e.id} 沿唯一因果链与已有回应 ${listener.id} 建立不可切分关联` });
    }
  }
  return { events, corrections };
}
function inventoryIssues(events, sources, base, settings) {
  const errors = [], bySource = new Map(sources.map(s => [s.id, s])), byId = new Map();
  if (!events.length) return [issue('empty_events', '没有返回事件清单，请按原文生成事件，不要把整篇误当一个 30 秒单元')];
  for (const e of events) {
    if (!e.id || byId.has(e.id)) errors.push(issue('event_id', `事件 ID 缺失或重复：${e.id || '未填写'}`));
    byId.set(e.id, e);
    if (!Array.isArray(e.source_ids) || !e.source_ids.length || e.source_ids.some(id => !bySource.has(id))) errors.push(issue('source', `事件 ${e.id} 缺少有效原文出处`, null, e.id));
    if (e.kind === 'dialogue') {
      const source = sources.find(s => s.kind === 'dialogue' && Array.isArray(e.source_ids) && e.source_ids.includes(s.id) && e.dialogue === s.dialogue && e.speaker === s.speaker);
      if (!source) errors.push(issue('dialogue_text', `对白 ${e.id} 的台词/说话人与原文不一致`, null, e.id));
      const isReply = isDialogueReply(e, events);
      if (!e.must_complete_with?.length && !isReply) errors.push(issue('response_link', `对白 ${e.id} 的回应关联未明确；可使用已有回答或动作，不必新增反应镜头`, null, e.id));
    }
  }
  for (const source of sources.filter(s => s.kind !== 'heading')) {
    const matches = events.filter(e => Array.isArray(e.source_ids) && e.source_ids.includes(source.id) && (source.kind !== 'dialogue' || e.kind === 'dialogue'));
    if (!matches.length) errors.push(issue('missing_source', `原文 ${source.id} 未覆盖：${source.text.trim()}`));
    if (source.kind === 'dialogue' && matches.length > 1) errors.push(issue('duplicate_dialogue', `原文 ${source.id} 的对白被重复安排`));
  }
  for (const e of events) {
    for (const id of e.must_complete_with || []) {
      if (!byId.has(id)) errors.push(issue('response_missing', `事件 ${e.id} 关联的结果 ${id} 不存在`, null, e.id));
      else if (e.kind === 'dialogue' && id === e.id) errors.push(issue('response_self', `对白 ${e.id} 不能把自己当成回应`, null, e.id));
      else if (e.kind === 'dialogue') {
        const pending = [id], visited = new Set(); let follows = false;
        while (pending.length) {
          const current = pending.pop();
          if (current === e.id) { follows = true; break; }
          if (visited.has(current)) continue;
          visited.add(current);
          const deps = byId.get(current)?.depends_on;
          if (Array.isArray(deps)) pending.push(...deps);
        }
        if (!follows) errors.push(issue('response_dependency', `对白 ${e.id} 与回应 ${id} 没有因果依赖，不可仅填一个无关ID`, null, e.id));
      }
    }
  }
  try { base.schedule(events); } catch (e) { errors.push(issue('event_graph', e.message.replace(/^BLOCKED_REVIEW[：:]\s*/, ''))); }
  if (settings && !errors.some(e => ['event_id', 'source', 'event_graph'].includes(e.code))) {
    const candidates = timingCandidates(events, sources, settings, null, base);
    for (const group of candidates.oversized_groups) errors.push(issue('indivisible_capacity', `不可切分组 ${group.first_event}～${group.last_event} 共 ${group.estimated_ms / 1000} 秒，超过每段 ${settings.clip_seconds} 秒。检查 must_complete_with 是否把普通先后顺序误当不可切分；只解除已有结果完成后的误关联，真实对白回应/动作结果仍须保留。真实不可切分则说明具体原文冲突。`));
  }
  return errors;
}

// Calculate temporal candidates, not artistic closure. The model must still confirm
// the narrative/visual result and give evidence for any performance-time adjustment.
function timingCandidates(events, sources, settings, cap, base) {
  const sourceOrder = new Map(sources.map((s, i) => [s.id, i]));
  const ordered = [...events].sort((a, b) => Math.min(...a.source_ids.map(s => sourceOrder.get(s))) - Math.min(...b.source_ids.map(s => sourceOrder.get(s))));
  const positions = new Map(ordered.map((e, i) => [e.id, i])), forbidden = new Set();
  const bind = (a, b) => { for (let k = Math.min(a, b) + 1; k <= Math.max(a, b); k++) forbidden.add(k); };
  const sourceFirst = new Map();
  for (const [i, e] of ordered.entries()) {
    for (const id of e.must_complete_with || []) if (positions.has(id)) bind(i, positions.get(id));
    for (const id of e.depends_on) if (positions.get(id) > i) bind(i, positions.get(id));
    for (const s of e.source_ids) { if (sourceFirst.has(s)) bind(sourceFirst.get(s), i); else sourceFirst.set(s, i); }
  }
  const boundaries = Array.from({ length: ordered.length + 1 }, (_, i) => i).filter(i => !forbidden.has(i));
  const measure = (start, end) => {
    const selected = ordered.slice(start, end), ids = new Set(selected.map(e => e.id));
    return base.schedule(selected.map(e => ({ ...e, depends_on: e.depends_on.filter(id => ids.has(id)) }))).duration_ms;
  };
  const oversized = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i - 1], end = boundaries[i], ms = measure(start, end);
    if (ms > settings.clip_seconds * 1000) oversized.push({ first_event: ordered[start].id, last_event: ordered[end - 1].id, estimated_ms: ms });
  }
  if (!cap) return { oversized_groups: oversized };
  const legal = legalSeconds(settings, cap), ranges = [];
  for (let a = 0; a < boundaries.length - 1; a++) for (let b = a + 1; b < boundaries.length; b++) {
    const start = boundaries[a], end = boundaries[b], ms = measure(start, end);
    if (ms > settings.clip_seconds * 1000) continue;
    const slot = legal.find(s => s * 1000 >= ms);
    if (!slot) continue;
    ranges.push({ start, end, first_event: ordered[start].id, last_event: ordered[end - 1].id,
      estimated_ms: ms, request_seconds: slot, performance_gap_ms: Math.max(0, slot * 1000 - ms - 1000) });
  }
  // Dynamic programming provides an advisory complete partition. Manual budgets
  // remain independently validated after semantic closure and timing are confirmed.
  const best = new Map([[0, { cost: 0, ranges: [] }]]);
  for (const start of boundaries) {
    const prior = best.get(start); if (!prior) continue;
    for (const range of ranges.filter(r => r.start === start)) {
      const cost = prior.cost + 1 + range.performance_gap_ms / 3000 +
        (settings.duration_mode === 'target' ? (settings.clip_seconds * 1000 - range.estimated_ms) / 10000 : 0);
      if (!best.has(range.end) || cost < best.get(range.end).cost) best.set(range.end, { cost, ranges: [...prior.ranges, range] });
    }
  }
  return { oversized_groups: oversized, boundary_after: boundaries.slice(1).map(i => ordered[i - 1].id),
    suggested_ranges: best.get(ordered.length)?.ranges || [], ranges,
    note: '这些仅是程序计时与依赖允许的候选，不代表叙事闭合。performance_gap_ms>0 不能直接提交，须重新组合或为已有表演给出合理时间依据，禁止空等补时。' };
}
function candidateContext(candidates) {
  // Hundreds of overlapping ranges repeat the same arithmetic and inflate model
  // input. Keep the full table in the diagnostic report, send nearby alternatives.
  const ranges = candidates.suggested_ranges.flatMap(chosen => candidates.ranges
    .filter(r => r.start === chosen.start && r.end !== chosen.end)
    .sort((a, b) => Math.abs(a.end - chosen.end) - Math.abs(b.end - chosen.end)).slice(0, 4));
  return { ...candidates, ranges };
}
function allocationRepairContext(context, previous, units, issues, events, candidates) {
  const indexes = new Set();
  for (const problem of issues) if (Number.isInteger(problem.unit)) {
    indexes.add(problem.unit);
    if (problem.unit > 1) indexes.add(problem.unit - 1);
    if (problem.unit < units.length) indexes.add(problem.unit + 1);
  }
  if (!indexes.size) for (let i = 1; i <= units.length; i++) indexes.add(i);
  const affected = [...indexes].filter(i => i > 0 && i <= units.length);
  const eventIds = new Set(affected.flatMap(i => (units[i - 1]?.events || []).filter(e => e.kind !== 'initial').map(e => e.id)));
  const neighbors = affected.flatMap(i => [units[i - 1], units[i - 2], units[i]]).filter(Boolean);
  const lockedIds = new Set(neighbors.flatMap(u => (u.events || []).filter(e => e.kind !== 'initial').flatMap(e => [e.id, ...(e.must_complete_with || []), ...(e.depends_on || [])])));
  return { settings: context.settings, capability: context.capability, legal_request_seconds: context.legal_request_seconds,
    affected_units: affected, events: events.filter(e => eventIds.has(e.id) || lockedIds.has(e.id)),
    previous: { units: previous.units.map((unit, index) => ({ index: index + 1, main_arc: unit.main_arc,
      auxiliary_modes: unit.auxiliary_modes, space_type: unit.space_type, transition_reason: unit.transition_reason,
      initial_state: unit.initial_state, final_state: unit.final_state, event_ids: unit.event_ids || unit.events?.filter(e => e.kind !== 'initial').map(e => e.id), closure: unit.closure })) },
    reviewed_units: units.filter(u => affected.includes(u.index)).map(u => ({ index: u.index, estimated_story_ms: u.estimated_story_ms,
      request_duration_ms: u.request_duration_ms, event_ids: u.events.filter(e => e.kind !== 'initial').map(e => e.id), closure: u.closure })),
    timing_candidates: candidateContext(candidates), issues };
}

function mergeEventRepair(previous, parsed) {
  if (!Array.isArray(parsed?.events)) return parsed;
  const merged = new Map(previous.map(e => [e.id, e]));
  for (const id of parsed.remove_event_ids || []) merged.delete(id);
  for (const e of parsed.events) if (e?.id) merged.set(e.id, { ...merged.get(e.id), ...e });
  return { ...parsed, events: [...merged.values()] };
}
function mergeAllocationRepair(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('定向修正必须返回JSON对象，已保留上一版单元规划');
  let units = patch.units;
  if (!Array.isArray(units) && Array.isArray(patch.unit_replacements)) {
    units = structuredClone(previous?.units || []);
    const replacements = [...patch.unit_replacements].sort((a, b) => b.index - a.index), seen = new Set();
    for (const replacement of replacements) {
      if (!Number.isInteger(replacement.index) || replacement.index < 1 || replacement.index > units.length || seen.has(replacement.index) || !Array.isArray(replacement.units)) throw new Error('定向修正的单元编号无效，请返回完整单元分配');
      seen.add(replacement.index); units.splice(replacement.index - 1, 1, ...replacement.units);
    }
  }
  if (!Array.isArray(units)) {
    if (!Array.isArray(previous?.units)) throw new Error('定向修正未返回单元规划，且没有可保留的上一版计划');
    units = structuredClone(previous.units);
  }
  const updates = new Map((Array.isArray(previous?.event_updates) ? previous.event_updates : []).map(e => [e.id, e]));
  if (patch.event_updates != null && !Array.isArray(patch.event_updates)) throw new Error('event_updates 必须为数组');
  for (const e of patch.event_updates || []) updates.set(e.id, { ...updates.get(e.id), ...e });
  return { ...patch, units, event_updates: [...updates.values()] };
}

function assembleUnits(parsed, events) {
  const eventById = new Map(events.map(e => [e.id, e]));
  const assembled = (parsed?.units || []).map((unit, index) => {
    const ids = unit.event_ids || (unit.events || []).map(e => e.id);
    const selected = ids.map(id => {
      if (!eventById.has(id)) throw new Error(`单元 ${index + 1} 使用了未定义事件 ${id}`);
      return structuredClone(eventById.get(id));
    });
    const startId = `unit_${index + 1}_entry`;
    if (eventById.has(startId)) throw new Error('事件 ID 与单元入口标记冲突');
    const local = new Set(ids);
    for (const e of selected) {
      e.external_dependencies = (e.depends_on || []).filter(id => !local.has(id));
      e.depends_on = (e.depends_on || []).filter(id => local.has(id));
      if (!e.depends_on.length) e.depends_on = [startId];
    }
    const initial = { id: startId, kind: 'initial', duration_ms: 0, depends_on: [], resources: [], source_ids: selected[0]?.source_ids || [], must_complete_with: [] };
    return { ...unit, index: index + 1, events: [initial, ...selected] };
  });
  for (let i = 1; i < assembled.length; i++) if (['A_CONTINUOUS', 'B_TRANSFER'].includes(assembled[i].space_type)) {
    assembled[i].initial_state = structuredClone(assembled[i - 1].final_state);
  }
  return assembled;
}
function reviewUnits(units, sources, script, settings, cap, base) {
  const errors = [], output = [], placed = new Map(), covered = new Map();
  if (!units.length) errors.push(issue('units_empty', '规划没有视频单元；整篇需拆成多个单元，每个单元按所选时长规划'));
  for (const [index, unit] of units.entries()) {
    for (const e of unit.events.filter(e => !/^unit_\d+_entry$/.test(e.id))) {
      if (placed.has(e.id)) errors.push(issue('duplicate_event', `事件 ${e.id} 被放进多个单元`, index + 1, e.id));
      placed.set(e.id, index);
      for (const s of e.source_ids || []) {
        if (covered.has(s) && covered.get(s) !== index) errors.push(issue('split_source', `完整语义 ${s} 被拆到多个单元`, index + 1, e.id));
        covered.set(s, index);
      }
    }
    const row = { ...unit, capacity_ms: settings.clip_seconds * 1000 };
    try { row.estimated_story_ms = base.schedule(unit.events).duration_ms; } catch (_) {}
    const localSources = sources.filter(s => unit.events.some(e => e.source_ids?.includes(s.id)));
    // Review each unit independently so one bad unit does not hide all other unit failures.
    try {
      const checked = base.validatePlan({ units: [unit] }, script, settings.clip_seconds, cap, null, { sources: localSources });
      Object.assign(row, checked.units[0], { index: index + 1 });
    } catch (e) { errors.push(issue('unit_invalid', e.message.replace(/^BLOCKED_REVIEW[：:]\s*/, '').replace(/单元 1\b/g, `单元 ${index + 1}`), index + 1)); }
    if (index && unit.space_type !== 'C_NARRATIVE_JUMP' && base.STATE_KEYS.some(key => unit.initial_state?.[key] !== units[index - 1].final_state?.[key])) errors.push(issue('state_continuity', `单元 ${index + 1} 初始状态未明确继承上一单元；只修正有依据的衔接`, index + 1));
    if (index && unit.space_type === 'C_NARRATIVE_JUMP' && !unit.transition_reason?.trim()) errors.push(issue('jump_reason', `单元 ${index + 1} 的叙事跳跃缺少原文依据`, index + 1));
    output.push(row);
  }
  for (const [index, unit] of units.entries()) for (const e of unit.events) {
    for (const dep of e.external_dependencies || []) if (!placed.has(dep) || placed.get(dep) >= index) errors.push(issue('cross_dependency', `事件 ${e.id} 依赖的 ${dep} 尚未在前一单元完成`, index + 1, e.id));
  }
  const content = sources.filter(s => s.kind !== 'heading');
  for (const s of content) if (!covered.has(s.id)) errors.push(issue('coverage', `原文 ${s.id} 未分配到单元：${s.text.trim()}`));
  for (let i = 1; i < content.length; i++) if (covered.get(content[i].id) < covered.get(content[i - 1].id)) errors.push(issue('source_order', `原文 ${content[i].id} 被提前，请保持原文顺序`));
  if (settings.manual_count && units.length !== settings.manual_count) errors.push(issue('manual_count', `人工指定 ${settings.manual_count} 段，当前为 ${units.length} 段；请在不删改原文的前提下重新分配，无法满足则解释冲突`));
  const complete = output.length > 0 && output.every(u => Number.isFinite(u.request_duration_ms));
  const total = complete ? output.reduce((sum, u) => sum + u.request_duration_ms, 0) / 1000 : null;
  if (settings.manual_total_seconds && complete && Math.abs(total - settings.manual_total_seconds) > settings.total_tolerance_seconds) errors.push(issue('manual_total', `人工指定总时长 ${settings.manual_total_seconds} 秒，规划请求总计 ${total} 秒；允许 ${settings.total_tolerance_seconds} 秒误差，请重规划或明确冲突`));
  return { units: output, issues: errors, total_request_seconds: total };
}

function blockReason(parsed) {
  if (parsed?.blocked) return String(parsed.blocked);
  return (Array.isArray(parsed?.units) ? parsed.units : []).find(u => /^blocked[：:]/i.test(u?.main_arc || ''))?.main_arc || null;
}
function closureChecks(units, sources) {
  return units.map((unit, index) => {
    const ending = unit.events.filter(e => e.kind !== 'initial').slice(-6);
    const following = (units[index + 1]?.events || []).filter(e => e.kind !== 'initial').slice(0, 4);
    const ids = new Set([...ending, ...following].flatMap(e => e.source_ids || []));
    return { unit: index + 1, declared_closure: unit.closure, ending_events: ending,
      next_events: following, source_excerpt: sources.filter(s => ids.has(s.id)) };
  });
}
function closureReviewIssues(parsed, count) {
  const rows = Array.isArray(parsed?.boundaries) ? parsed.boundaries : [];
  return Array.from({ length: count }, (_, i) => {
    const matches = rows.filter(row => row?.unit === i + 1), row = matches[0];
    if (matches.length !== 1 || typeof row?.closed !== 'boolean' || !String(row?.reason || '').trim()) return issue('closure_review_missing', `单元 ${i + 1} 缺少明确的边界复核结论`, i + 1);
    if (!row.closed) return issue('semantic_closure', `单元 ${i + 1} 边界未闭合：${row.reason}`, i + 1);
    return null;
  }).filter(Boolean);
}
async function generate(db, log, episodeId, model, capacity, manualCount, rawSettings, base) {
  base.init(db);
  const tenantId = getTenantId();
  const episode = tenantId
    ? db.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL AND COALESCE(organization_id,1)=?').get(Number(episodeId), tenantId)
    : db.prepare('SELECT * FROM episodes WHERE id=? AND deleted_at IS NULL').get(Number(episodeId));
  if (!episode) throw new Error('剧集不存在');
  const script = String(episode.script_content || episode.description || '');
  const config = video.getDefaultVideoConfig(db);
  if (!config) throw new Error('请先选择视频配置');
  const cap = video.getVideoDurationCapability(config);
  const settings = planningSettings({ clip_seconds: capacity, storyboard_count: manualCount, ...rawSettings });
  const sources = sourceSegments(script), id = crypto.randomUUID();
  const report = { version: 2, settings, capability: cap, phase: 'settings', units: [], issues: [], corrections: [], attempts: [], repair_count: 0,
    source_hash: crypto.createHash('sha256').update(script).digest('hex') };
  db.prepare('INSERT INTO narrative_unit_plans VALUES (?,?,?,?,?,?)').run(id, Number(episodeId), 'planning', JSON.stringify(report), null, new Date().toISOString());
  const persist = (status = 'planning', error = null) => db.prepare('UPDATE narrative_unit_plans SET status=?,payload=?,error=? WHERE id=?').run(status, JSON.stringify(report), error, id);
    const request = async (phase, prompt, input) => {
    report.phase = phase; persist();
    const raw = await ai.generateText(db, log, 'text', JSON.stringify(input), prompt, { scene_key: 'storyboard_extraction', model: model || undefined, max_tokens: 24000, silence_timeout_ms: 300000 });
    const parsed = safeParseAIJSON(raw, null, log);
    report.attempts.push({ phase, repair: report.repair_count, response: parsed || raw });
    return parsed;
  };
  const context = { settings, capability: cap, legal_request_seconds: legalSeconds(settings, cap), source_position_unit: 'UTF-16字符位置，不是秒', source_segments: sources };
  const common = `你为整篇原剧本规划多个视频生成单元，不是把整篇压入一个${capacity}秒单元。只做原文事件与分段规划，不调用视频提示词Skill。原台词、说话人、因果顺序、人物与关键动作不得增删改写。原文id和char_start/char_end是文本定位，不是时间。场景不是视频单元，一个场景可拆多段；全能模式一个单元可有多个子镜头。所有阶段遵守settings：自动数量和自动总时长仅参考；人工指定必须纳入预算，不得忽略。target表示围绕所选秒数安排自然表演，capacity表示只设上限允许更短自然闭合。固定通道需在合法档位自然闭合，不得用加新剧情、异常语速或无功能等待补时。画幅/语言/风格用于表现，不改变原文；未选旁白不得加旁白；单张参考图不限制子镜头数。不能满足时说明具体事件和参数冲突，不要笼统说整篇放不进30秒。`;
  const inventoryPrompt = `${common}\n当前阶段只整理整篇事件清单和先后/并行依赖，不划分单元，不要求整篇在段容量内。标题/场号供上下文，不必变成有时长的事件。动作以完整结果为单位，不能用整场一个事件逃避拆分。对白逐字保留，包括表演括号。每句对白至少按可辨语速估时，通常每秒3～4字，绝不快于5字；动作使用可执行的实际时长。已有回答、接收、拒绝、松手等可承担回应，不为每句加独立反应镜头。回应事件使用responds_to指向对白，或在对白must_complete_with写回应ID，且有depends_on因果关系。事件不必全部串行，但同人物同手/声音不可同时冲突。所有非标题原文片段必须覆盖，完整台词恰好一个dialogue事件。只返回JSON {events:[{id,kind:'dialogue|action|reaction|result|effect|sound',description,duration_ms,depends_on:[],resources:['人物.左手'],source_ids:['S1'],must_complete_with:[],responds_to:'被回应事件ID（如有）',speaker:'仅对白',dialogue:'仅对白原文'}]}。不要输出单元或分镜。`;
  try {
    report.issues = settingsIssues(settings, cap);
    if (report.issues.length) throw new Error('设置之间存在冲突');
    const lockRules = '\n务必区分：depends_on只是先后顺序，允许在前一动作完成后跨段；must_complete_with只绑定缺一不可的完整语义或尚未完成的动作结果。不能因为事件相邻就把整场串成不可切分链。回答已承担上句听者反应时，不必再绑定下一句。站稳/接住/松手后的新行动通常是可切点，不能继续无限绑定。每个绑定须基于原文，若解除错误绑定需保留depends_on。';
    let parsed = await request('events', inventoryPrompt + lockRules, context), events = [];
    while (true) {
      const normalized = normalizeEvents(parsed?.events);
      events = normalized.events; report.events = events; report.corrections.push(...normalized.corrections);
      report.issues = blockReason(parsed) ? [issue('model_blocked', blockReason(parsed))] : inventoryIssues(events, sources, base, settings);
      if (!report.issues.length) break;
      if (report.repair_count >= 2) throw new Error('事件清单仍未通过校验');
      report.repair_count++;
      const patch = await request('repair_events', inventoryPrompt + lockRules + '\n仅针对issues修正，保留已正确事件的ID和原文，不重写剧情；返回{events:[{id,仅需要修改的字段,repair_reason:修正依据}],remove_event_ids:[明确需要移除的旧ID]}，未列出的原事件和字段自动保留，新增事件才需要完整字段。解除错误关联时不能整批清空must_complete_with，要逐个保留真正不可切分的对白回应、攻击接触/防御/落空和动作结果。已经是某句对白回应的回答不需要无限追加另一个反应。', { ...context, previous_events: events, issues: report.issues });
      parsed = mergeEventRepair(events, patch);
    }
    const allocationPrompt = `${common}\n当前阶段把已核对时间的事件分配到多个视频单元。事件清单覆盖整篇，单元内只覆盖分配给它的部分，所有单元合起来覆盖全篇。不能把同一场景强塞一段。先计算关键路径，在上限内找叙事+视觉双重闭合点；一条主弧、最多2辅助模式。对白与关键回应、交接与接收/拒绝、攻击与命中/防御/落空、特效与反馈、穿门/跨障碍与站稳不可中途切断。摄影机与动作并行，不能延长故事时间。依赖和must_complete_with要满足。连续空间下一单元initial_state逐字段继承上一final_state；原文叙事跳跃可另起C_NARRATIVE_JUMP并写transition_reason。同一场景内分段是A_CONTINUOUS。状态字段完整具体，不能同前或未明确：${base.STATE_KEYS.join(',')}。\n只返回JSON {units:[{main_arc,auxiliary_modes:[],space_type:'A_CONTINUOUS|B_TRANSFER|C_NARRATIVE_JUMP',transition_reason,initial_state:{},final_state:{},event_ids:['e1','e2'],closure:{event_id:'最后结果ID',narrative:true,visual:true,reason:'可观察结果'}}],event_updates:[]}。event_updates可按{id,duration_ms,depends_on,must_complete_with,responds_to}更正原事件的合理表演时间或关联，不改变台词/说话人/原文/事件内容，不新增事件；每次延长必须说明timing_reason，不能通过长时间等待凑满档位。计时单位毫秒，3000表示3秒。自动数量可调整；每段约目标优先自然接近目标，并解释偏离原因；每段最多可更短。若原文一完整台词超过容量请返回具体blocked，不删除或拆坏语义。`;
    const candidateTiming = timingCandidates(events, sources, settings, cap, base);
    report.timing_candidates = candidateTiming;
    const timingRules = '\n先看timing_candidates：程序已计算依赖允许的边界和关键路径。优先审查suggested_ranges是否有叙事与视觉闭合，再参考其它ranges；不允许切断boundary_after以外的未完成语义。estimated_ms是计算值。固定[15,30]表示仅能请求15或30秒；每段故事实际闭合须分别在14～15秒或29～30秒，不能把19秒或26秒直接当30秒。存在performance_gap_ms时需重新组合或从一开始合理设计已有表演节奏，通过event_updates提供具体毫秒与timing_reason，不能额外空等或加剧情。每段须含独立反应或结果，可把已有完成动作的kind由action标为result，不能为过检查新增剧情。连续空间的后段initial_state由程序逐字段继承前段final_state，可省略重复填写；第一段或叙事跳跃必须完整填写。闭合事件须在所有故事轨结束之后并与各轨依赖汇合。';
    let allocation = await request('allocation', allocationPrompt + timingRules, { ...context, events, timing_candidates: candidateContext(candidateTiming) });
    while (true) {
      const updates = Array.isArray(allocation?.event_updates) ? allocation.event_updates : [], edited = structuredClone(events);
      const updateErrors = [];
      for (const patch of updates) {
        const e = edited.find(x => x.id === patch.id);
        if (!e) { updateErrors.push(issue('unknown_update', `无法修正未知事件 ${patch.id}`)); continue; }
        if (patch.duration_ms > e.duration_ms && !String(patch.timing_reason || '').trim()) { updateErrors.push(issue('timing_reason', `事件 ${e.id} 延长时间必须说明原文表演依据`)); continue; }
        for (const key of ['duration_ms', 'depends_on', 'must_complete_with', 'responds_to']) if (Object.hasOwn(patch, key)) e[key] = patch[key];
        if (['action', 'reaction', 'result'].includes(e.kind) && ['action', 'reaction', 'result'].includes(patch.kind)) e.kind = patch.kind;
      }
      const normalized = normalizeEvents(edited); report.corrections.push(...normalized.corrections);
      const eventErrors = inventoryIssues(normalized.events, sources, base, settings);
      let review;
      try {
        review = reviewUnits(assembleUnits(allocation, normalized.events), sources, script, settings, cap, base);
      } catch (e) { review = { units: [], issues: [issue('allocation_shape', e.message)] }; }
      report.units = review.units; report.events = normalized.events;
      report.total_request_seconds = review.total_request_seconds;
      report.issues = [...updateErrors, ...eventErrors, ...review.issues];
      if (blockReason(allocation)) report.issues.unshift(issue('model_blocked', blockReason(allocation)));
      if (!report.issues.length) {
        const audit = await request('closure_review', '你是独立的剧本分段边界审查员，只核对原文，不重写剧情。逐段检查ending_events与next_events，不能相信declared_closure自称闭合。攻击已发出但尚未接触/防御/落空，法术尚未完成接触反馈，交接尚未接收/拒绝，移位/跌倒尚未站稳，核心台词或关键听者反应跨段，都必须closed:false。尤其“气浪撞向某人”不是已经命中或防住；一句应答不能代替尚未完成的攻防结果。同一空间可自然分段，不必要求全场冲突彻底结束。最后一段也要检查是否遗漏当前动作结果。只返回JSON {boundaries:[{unit:编号,closed:true或false,reason:引用具体原文事件说明理由}]}，每个单元恰好一个结论。', { settings, closure_checks: closureChecks(report.units, sources) });
        report.closure_review = audit;
        report.issues = closureReviewIssues(audit, report.units.length);
      }
      if (!report.issues.length) { report.phase = 'validated'; persist('validated'); return { id, ...report }; }
      if (report.repair_count >= 2) throw new Error('单元规划仍未通过校验');
      report.repair_count++;
      const repairCandidates = eventErrors.length ? candidateTiming : timingCandidates(normalized.events, sources, settings, cap, base);
      const repairInput = allocationRepairContext(context, allocation, review.units, report.issues, normalized.events, repairCandidates);
      const patch = await request('repair_allocation', allocationPrompt + timingRules + '\n按issues定向修正，可拆分/重组超时单元。优先返回{unit_replacements:[{index:原单元编号从1开始,units:[替换该单元的一段或多段]}],event_updates:[]}。输入只包含受影响单元及其相邻状态；未列出单元自动保留，仅修改必要的邻接衔接。输出完整的受影响替换单元状态与事件ID，避免丢失未列出的动作。需要全局重分时才返回完整units。对白回应允许由另一句回答承担，作为回应的回答不需要无限新增反应。', repairInput);
      try { allocation = mergeAllocationRepair(allocation, patch); }
      catch (e) { allocation = { ...allocation, blocked: e.message }; }
    }
  } catch (err) {
    if (!report.issues.length) report.issues = [issue('service_error', err.message)];
    const message = `BLOCKED_REVIEW：${report.issues.slice(0, 3).map(e => e.message).join('；')}${report.issues.length > 3 ? `；另有 ${report.issues.length - 3} 项，见单元规划报告` : ''}`;
    report.phase = 'blocked'; persist('blocked', message);
    const failure = new Error(message); failure.code = 'BLOCKED_REVIEW'; throw failure;
  }
}
module.exports = { planningSettings, settingsIssues, sourceSegments, dialogueMinimum, isDialogueReply, normalizeEvents, inventoryIssues, timingCandidates, candidateContext, allocationRepairContext, closureChecks, closureReviewIssues, mergeEventRepair, mergeAllocationRepair, assembleUnits, reviewUnits, generate };
