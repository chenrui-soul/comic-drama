const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const configs = require('../src/services/aiConfigService');
const { generateText } = require('../src/services/aiClient');

test('text endpoints reject website responses and still accept real chat formats', async t => {
  let responseType = 'text/html';
  let responseBody = '<html><body>API portal</body></html>';
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': responseType });
    res.end(responseBody);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const config = {
    provider: 'openai', base_url: `http://127.0.0.1:${server.address().port}`,
    api_key: 'synthetic-key', model: ['test-model'], is_active: true, is_default: true,
  };
  t.mock.method(configs, 'listConfigs', () => [config]);
  const log = { info() {}, warn() {} };
  await assert.rejects(generateText(null, log, 'text', 'test'), /HTML.*Base URL/);
  await assert.rejects(configs.testConnection(config), /HTML.*Base URL/);

  responseType = 'application/json';
  responseBody = '{}';
  await assert.rejects(configs.testConnection(config), /未返回有效的对话结果/);
  responseBody = 'not-json';
  await assert.rejects(configs.testConnection(config), /未返回有效的 JSON/);
  responseBody = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
  await configs.testConnection(config);

  responseType = 'text/event-stream';
  responseBody = 'data: {"choices":[{"delta":{"content":"角色正文"}}]}\n\ndata: [DONE]\n\n';
  assert.equal(await generateText(null, log, 'text', 'test'), '角色正文');
});
