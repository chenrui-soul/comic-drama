const { test } = require('node:test');
const assert = require('node:assert/strict');
const cap = require('../src/services/videoDurationCapability');
test('exact Seedance 2.5 family does not match Agnes or arbitrary 2.5 models', () => {
  for (const name of ['Seedance 2.5','doubao-seedance-2-5-260128','seedance-2.5']) assert.equal(cap.resolve({ api_protocol: 'doubao_manager' }, name).max, 30);
  for (const name of ['Agnes 2.5','model-2.5','seedance-2.50','seedance-2.5-fake']) assert.equal(cap.isSeedance25(name), false);
});
test('strict duration inputs and fixed channel values', () => {
  const cfg = { settings: { video_duration: { mode: 'range', min_seconds: 4, max_seconds: 30, step_seconds: 1 } } };
  for (const value of [0,-1,'',null,NaN,undefined,true,[],{},'30',29.7,3,31]) assert.equal(cap.validate(cfg, '', value).ok, false, String(value));
  for (const value of [4,15,20,25,26,30]) assert.equal(cap.validate(cfg,'',value).ok, true);
  cfg.settings.video_duration = { mode: 'fixed', allowed_seconds: [15,30] };
  assert.equal(cap.validate(cfg,'',25).ok,false);
});
test('existing user duration declaration is authoritative without a capability verification gate', () => {
  const cfg={ settings:{video_duration:{mode:'range',min_seconds:4,max_seconds:30}}};
  assert.equal(cap.resolve(cfg,'用户自定义模型').max,30);assert.equal(cap.validate(cfg,'用户自定义模型',30).ok,true);
  assert.equal(cap.resolve(cfg,'Seedance 2.0').max,30);
  assert.throws(()=>cap.parseCapability({mode:'fixed',allowed_seconds:[29.7]}));
  assert.equal(cap.resolve({settings:{video_duration:{mode:'range',min_seconds:30,max_seconds:4}}}).mode,'invalid');
});
