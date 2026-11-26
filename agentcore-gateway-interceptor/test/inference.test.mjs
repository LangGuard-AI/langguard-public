import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../src/interceptor.mjs';
import { API_KEY, ENV, TRACEPARENT, TRACE_ID, fakeFetch, fixture, invokeResult, json } from './helpers.mjs';

const PASS = { interceptorOutputVersion: '1.0', http: {} };
const MODEL_ID = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';
const KEY_ID = 'ASIAIOSFODNN7EXAMPLE';
const SIGV4 =
  `AWS4-HMAC-SHA256 Credential=${KEY_ID}/20261126/us-east-1/bedrock/aws4_request, ` +
  'SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, ' +
  'Signature=fe5f80f77d5fa3beca038a248ff027d0445342fe2855ddc963176630326f1024';
const PROMPT = 'Summarize the refund policy for order ORD-10024';

const BEDROCK_BODY = {
  anthropic_version: 'bedrock-2023-05-31',
  max_tokens: 1024,
  system: 'You are a coding assistant.',
  messages: [{ role: 'user', content: PROMPT }],
};
const MESSAGES_BODY = { ...BEDROCK_BODY, model: 'claude-sonnet-4-5', stream: true };
const CHAT_BODY = { model: 'openai.gpt-oss-120b-1:0', messages: [{ role: 'user', content: PROMPT }] };

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64');
const encodedModel = encodeURIComponent(MODEL_ID);

function httpEvent({ method = 'POST', path, body, headers = { 'Content-Type': 'application/json', traceparent: TRACEPARENT } }) {
  return {
    interceptorInputVersion: '1.0',
    http: {
      gatewayRequest: {
        path,
        httpMethod: method,
        ...(headers ? { headers } : {}),
        ...(body !== undefined ? { body: typeof body === 'string' ? body : b64(body) } : {}),
      },
    },
  };
}

const deny = () => json(invokeResult({ valid: false, messages: [{ severity: 'error', message: 'Prompt has PII.' }] }));

function setup({ respond = () => json(invokeResult({ valid: true })), env = ENV, lookupCaller } = {}) {
  const { fetch, calls } = fakeFetch(respond);
  const lines = [];
  const handler = createHandler({
    fetch,
    getApiKey: async () => API_KEY,
    env,
    log: (l) => lines.push(l),
    ...(lookupCaller ? { lookupCaller } : {}),
  });
  return { handler, calls, lines, logged: () => JSON.parse(lines[0]) };
}

function blockResponse(output) {
  assert.deepEqual(Object.keys(output.http), ['transformedGatewayResponse']);
  const { statusCode, contentType, headers, body } = output.http.transformedGatewayResponse;
  return { statusCode, contentType, headers, body: JSON.parse(Buffer.from(body, 'base64').toString('utf8')) };
}

describe('inference route table', () => {
  const evaluated = [
    {
      name: 'POST /model/{model}/invoke',
      event: httpEvent({ path: `/inference/model/${encodedModel}/invoke`, body: BEDROCK_BODY }),
      payload: { dialect: 'bedrock_invoke', model: MODEL_ID, stream: false, body: BEDROCK_BODY, truncated: false },
    },
    {
      name: 'POST /model/{model}/invoke-with-response-stream',
      event: httpEvent({ path: `/inference/model/${encodedModel}/invoke-with-response-stream`, body: BEDROCK_BODY }),
      payload: { dialect: 'bedrock_invoke', model: MODEL_ID, stream: true, body: BEDROCK_BODY, truncated: false },
    },
    {
      name: 'POST /v1/messages',
      event: httpEvent({ path: '/inference/v1/messages', body: MESSAGES_BODY }),
      payload: { dialect: 'anthropic_messages', model: 'claude-sonnet-4-5', stream: true, body: MESSAGES_BODY, truncated: false },
    },
    {
      name: 'POST /v1/chat/completions',
      event: httpEvent({ path: '/inference/v1/chat/completions', body: CHAT_BODY }),
      payload: { dialect: 'openai_chat', model: 'openai.gpt-oss-120b-1:0', stream: false, body: CHAT_BODY, truncated: false },
    },
  ];

  for (const { name, event, payload } of evaluated) {
    it(`${name} goes to LangGuard as interceptor/invoke_model and passes when allowed`, async () => {
      const { handler, calls } = setup();
      const output = await handler(event);
      assert.deepEqual(output, PASS);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://langguard.internal.test/api/interceptor');
      assert.equal(calls[0].body.method, 'interceptor/invoke_model');
      assert.deepEqual(calls[0].body.params.payload, payload);
      assert.deepEqual(calls[0].body.params.config, { langguard: { agent_type: 'agentcore' } });
      assert.equal(calls[0].body.params.context.traceId, TRACE_ID);
    });
  }

  const passed = [
    ['POST /model/{model}/count-tokens', httpEvent({ path: `/inference/model/${encodedModel}/count-tokens`, body: BEDROCK_BODY })],
    ['GET /inference-profiles', httpEvent({ method: 'GET', path: '/inference/inference-profiles?type=SYSTEM_DEFINED' })],
    ['GET /v1/models', httpEvent({ method: 'GET', path: '/inference/v1/models' })],
    ['a path that is not under /inference', fixture('http-request-interceptor-input')],
    ['a path that only starts with the letters of /inference', httpEvent({ path: '/inferences/v1/messages', body: MESSAGES_BODY })],
    ['a RESPONSE event', {
      interceptorInputVersion: '1.0',
      http: {
        gatewayRequest: { path: '/inference/v1/messages', httpMethod: 'POST', body: b64(MESSAGES_BODY) },
        gatewayResponse: { statusCode: 200, headers: {}, isStreamingResponse: false, body: b64({ ok: true }), contentType: 'application/json' },
      },
    }],
  ];

  for (const [name, event] of passed) {
    it(`${name} passes unchanged without a LangGuard call`, async () => {
      const { handler, calls, logged } = setup();
      assert.deepEqual(await handler(event), PASS);
      assert.equal(calls.length, 0);
      assert.equal(logged().outcome, 'passthrough');
    });
  }

  const unsupported = [
    ['POST /v1/responses', '/inference/v1/responses', 'openai_chat'],
    ['POST /model/{model}/converse', `/inference/model/${encodedModel}/converse`, 'bedrock_invoke'],
    ['POST /v1/messages/count_tokens', '/inference/v1/messages/count_tokens', 'anthropic_messages'],
  ];

  const UNSUPPORTED = 'Blocked by LangGuard: LangGuard cannot check calls to this inference API, so this call is not allowed.';
  const ERROR_BODY = {
    bedrock_invoke: (message) => ({ message }),
    anthropic_messages: (message) => ({ type: 'error', error: { type: 'permission_error', message } }),
    openai_chat: (message) => ({ error: { message, type: 'permission_denied' } }),
  };

  for (const [name, path, format] of unsupported) {
    it(`${name} is blocked without a LangGuard call, in the ${format} error format`, async () => {
      const { handler, calls, logged } = setup();
      const response = blockResponse(await handler(httpEvent({ path, body: CHAT_BODY })));
      assert.equal(calls.length, 0);
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, ERROR_BODY[format](UNSUPPORTED));
      assert.equal(logged().outcome, 'unsupported');
    });
  }

  describe('a request path without the /inference prefix', () => {
    const unprefixed = (event) => {
      const copy = structuredClone(event);
      copy.http.gatewayRequest.path = copy.http.gatewayRequest.path.replace(/^\/inference/, '');
      return copy;
    };

    for (const { name, event, payload } of evaluated) {
      it(`${name} goes to LangGuard with the same payload`, async () => {
        const { handler, calls, logged } = setup();
        assert.deepEqual(await handler(unprefixed(event)), PASS);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].body.method, 'interceptor/invoke_model');
        assert.deepEqual(calls[0].body.params.payload, payload);
        assert.equal(logged().dialect, payload.dialect);
      });
    }

    it('POST /model/{model}/invoke is blocked when the policy denies it', async () => {
      const { handler } = setup({ respond: deny });
      const response = blockResponse(await handler(unprefixed(evaluated[0].event)));
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, { message: 'Blocked by LangGuard: Prompt has PII.' });
    });

    for (const [name, event] of [
      ['POST /model/{model}/count-tokens', httpEvent({ path: `/model/${encodedModel}/count-tokens`, body: BEDROCK_BODY })],
      ['GET /model/{model}/invoke', httpEvent({ method: 'GET', path: `/model/${encodedModel}/invoke` })],
      ['POST to a path that no row matches', httpEvent({ path: '/orders/v1/messages', body: MESSAGES_BODY })],
      ['POST /v1/orders of an HTTP target', httpEvent({ path: '/v1/orders', body: { order: 'ORD-10024' } })],
      ['POST /model/x/other of an HTTP target', httpEvent({ path: '/model/x/other', body: { order: 'ORD-10024' } })],
      ...unsupported.map(([name, path]) => [name, httpEvent({ path: path.replace(/^\/inference/, ''), body: CHAT_BODY })]),
    ]) {
      it(`${name} passes unchanged without a LangGuard call`, async () => {
        const { handler, calls, logged } = setup();
        assert.deepEqual(await handler(event), PASS);
        assert.equal(calls.length, 0);
        assert.equal(logged().outcome, 'passthrough');
      });
    }
  });
});

describe('LANGGUARD_GATEWAY_KIND=inference', () => {
  const INFERENCE_ENV = { ...ENV, LANGGUARD_GATEWAY_KIND: 'inference' };
  const UNSUPPORTED = 'Blocked by LangGuard: LangGuard cannot check calls to this inference API, so this call is not allowed.';

  for (const [path, body] of [
    ['/v1/orders', { error: { message: UNSUPPORTED, type: 'permission_denied' } }],
    ['/model/x/other', { message: UNSUPPORTED }],
    ['/v1/responses', { error: { message: UNSUPPORTED, type: 'permission_denied' } }],
    ['/v1/messages/count_tokens', { type: 'error', error: { type: 'permission_error', message: UNSUPPORTED } }],
  ]) {
    it(`blocks POST ${path} without /inference and with no LangGuard call`, async () => {
      const { handler, calls, logged } = setup({ env: INFERENCE_ENV });
      const response = blockResponse(await handler(httpEvent({ path, body: CHAT_BODY })));
      assert.equal(calls.length, 0);
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, body);
      assert.equal(logged().outcome, 'unsupported');
    });
  }

  for (const [name, event] of [
    ['GET /inference-profiles without /inference', httpEvent({ method: 'GET', path: '/inference-profiles?type=SYSTEM_DEFINED' })],
    ['POST /model/{model}/count-tokens without /inference', httpEvent({ path: `/model/${encodedModel}/count-tokens`, body: BEDROCK_BODY })],
    ['a RESPONSE event', {
      http: {
        gatewayRequest: { path: '/v1/orders', httpMethod: 'POST' },
        gatewayResponse: { statusCode: 200, body: b64({ ok: true }) },
      },
    }],
  ]) {
    it(`passes ${name}`, async () => {
      const { handler, calls } = setup({ env: INFERENCE_ENV });
      assert.deepEqual(await handler(event), PASS);
      assert.equal(calls.length, 0);
    });
  }

  it('sends POST /model/{model}/invoke without /inference to LangGuard', async () => {
    const { handler, calls } = setup({ env: INFERENCE_ENV });
    assert.deepEqual(await handler(httpEvent({ path: `/model/${encodedModel}/invoke`, body: BEDROCK_BODY })), PASS);
    assert.equal(calls[0].body.params.payload.model, MODEL_ID);
  });

  for (const value of ['Inference', 'mcp', ' inference']) {
    it(`blocks each REQUEST event with the "unavailable" text when the value is ${JSON.stringify(value)}`, async () => {
      const { handler, calls, logged } = setup({ env: { ...ENV, LANGGUARD_GATEWAY_KIND: value } });
      for (const event of [
        httpEvent({ path: `/inference/model/${encodedModel}/invoke`, body: BEDROCK_BODY }),
        httpEvent({ method: 'GET', path: '/inference/v1/models' }),
        httpEvent({ path: '/v1/orders', body: CHAT_BODY }),
      ]) {
        const response = blockResponse(await handler(event));
        assert.equal(response.statusCode, 403);
        assert.equal(
          response.body.message ?? response.body.error.message,
          'Blocked by LangGuard: the policy check is unavailable, so this model call is not allowed.',
        );
      }
      assert.equal(calls.length, 0);
      assert.equal(logged().outcome, 'unavailable');
      assert.equal(logged().reason, 'LANGGUARD_GATEWAY_KIND is not inference');
    });
  }
});

describe('path normalization', () => {
  const PROFILE = 'arn:aws:bedrock:us-east-1:111122223333:application-inference-profile/a1b2c3d4e5f6';
  const routed = [
    ['a repeated slash', '//inference/model/m/invoke', 'm'],
    ['an upper-case prefix', '/INFERENCE/model/m/invoke', 'm'],
    ['an upper-case static segment', '/Model/m/invoke', 'm'],
    ['a .. segment', '/x/../inference/model/m/invoke', 'm'],
    ['a percent-encoded static segment', '/%6Dodel/m/invoke', 'm'],
    ['no leading slash', 'inference/model/m/invoke', 'm'],
    ['a . segment and a trailing slash', '/inference/./model/m/invoke/', 'm'],
    ['a percent-encoded .. segment', '/inference/v1/%2E%2E/model/m/invoke', 'm'],
    ['a model ID in mixed case', '/inference/model/US.Anthropic.Claude/invoke', 'US.Anthropic.Claude'],
    ['an application inference profile ARN with a literal /', `/inference/model/${PROFILE}/invoke`, PROFILE],
    ['an application inference profile ARN with %2F', `/model/${encodeURIComponent(PROFILE)}/invoke`, PROFILE],
  ];

  for (const [name, path, model] of routed) {
    it(`a path with ${name} (${path}) goes to LangGuard and is blocked when the policy denies it`, async () => {
      const { handler, calls } = setup({ respond: deny });
      const response = blockResponse(await handler(httpEvent({ path, body: BEDROCK_BODY })));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].body.method, 'interceptor/invoke_model');
      assert.equal(calls[0].body.params.payload.model, model);
      assert.deepEqual(response.body, { message: 'Blocked by LangGuard: Prompt has PII.' });
    });
  }

  it('a /V1/Messages path goes to LangGuard as anthropic_messages', async () => {
    const { handler, calls } = setup();
    await handler(httpEvent({ path: '/inference//V1/Messages', body: MESSAGES_BODY }));
    assert.equal(calls[0].body.params.payload.dialect, 'anthropic_messages');
  });

  it('a path with a bad percent escape is blocked with the "not valid" text and no LangGuard call', async () => {
    const { handler, calls, logged } = setup();
    const response = blockResponse(await handler(httpEvent({ path: '/inference/model/m%E0%A4%A/invoke', body: BEDROCK_BODY })));
    assert.equal(calls.length, 0);
    assert.deepEqual(response.body, {
      message: 'Blocked by LangGuard: this is not a valid model request, so it was not sent for a policy check.',
    });
    assert.equal(logged().outcome, 'unsupported');
  });
});

describe('block format of each dialect', () => {
  const policyText = 'Blocked by LangGuard: Prompt has PII.';
  const cases = [
    {
      dialect: 'bedrock_invoke',
      event: httpEvent({ path: `/inference/model/${encodedModel}/invoke`, body: BEDROCK_BODY }),
      expected: {
        statusCode: 403,
        contentType: 'application/json',
        headers: { 'x-amzn-ErrorType': 'AccessDeniedException' },
        body: { message: policyText },
      },
    },
    {
      dialect: 'anthropic_messages',
      event: httpEvent({ path: '/inference/v1/messages', body: MESSAGES_BODY }),
      expected: {
        statusCode: 403,
        contentType: 'application/json',
        headers: undefined,
        body: { type: 'error', error: { type: 'permission_error', message: policyText } },
      },
    },
    {
      dialect: 'openai_chat',
      event: httpEvent({ path: '/inference/v1/chat/completions', body: CHAT_BODY }),
      expected: {
        statusCode: 403,
        contentType: 'application/json',
        headers: undefined,
        body: { error: { message: policyText, type: 'permission_denied' } },
      },
    },
  ];

  for (const { dialect, event, expected } of cases) {
    it(`a policy block of a ${dialect} call is a short-circuit response in that error format`, async () => {
      const { handler, logged } = setup({ respond: deny });
      assert.deepEqual(blockResponse(await handler(event)), expected);
      assert.equal(logged().outcome, 'block');
      assert.equal(logged().reason, 'policy');
    });
  }

  it('a Shadow mode result (valid false, severity warn) passes', async () => {
    const { handler } = setup({ respond: () => json(invokeResult({ valid: false, severity: 'warn' })) });
    assert.deepEqual(await handler(cases[0].event), PASS);
  });
});

describe('model requests that cannot be read', () => {
  for (const [name, event] of [
    ['a body that is not JSON', httpEvent({ path: `/inference/model/${encodedModel}/invoke`, body: b64('not json') })],
    ['a JSON array body', httpEvent({ path: `/inference/model/${encodedModel}/invoke`, body: [BEDROCK_BODY] })],
    ['no body', httpEvent({ path: `/inference/model/${encodedModel}/invoke` })],
    ['a messages body without a model', httpEvent({ path: '/inference/v1/messages', body: BEDROCK_BODY })],
  ]) {
    it(`${name} is blocked with the "not valid" text and no LangGuard call`, async () => {
      const { handler, calls, logged } = setup();
      const response = blockResponse(await handler(event));
      assert.equal(calls.length, 0);
      assert.equal(response.statusCode, 403);
      assert.equal(
        response.body.message ?? response.body.error.message,
        'Blocked by LangGuard: this is not a valid model request, so it was not sent for a policy check.',
      );
      assert.equal(logged().outcome, 'unsupported');
    });
  }
});

describe('duplicate keys in the body', () => {
  const NOT_VALID = 'Blocked by LangGuard: this is not a valid model request, so it was not sent for a policy check.';
  const SAFE = JSON.stringify([{ role: 'user', content: 'Hello' }]);
  const HIDDEN = JSON.stringify(BEDROCK_BODY.messages);
  const invoke = `/inference/model/${encodedModel}/invoke`;

  for (const [name, path, text] of [
    ['a repeated messages key', invoke, `{"anthropic_version":"bedrock-2023-05-31","max_tokens":10,"messages":${HIDDEN},"messages":${SAFE}}`],
    ['a repeated key with an escape', invoke, `{"anthropic_version":"bedrock-2023-05-31","messages":${HIDDEN},"\\u006dessages":${SAFE}}`],
    ['a repeated model key', '/inference/v1/messages', `{"model":"claude-sonnet-4-5","max_tokens":10,"model":"other","messages":${HIDDEN}}`],
  ]) {
    it(`${name} is blocked with the "not valid" text and no LangGuard call`, async () => {
      const { handler, calls, logged } = setup();
      const response = blockResponse(await handler(httpEvent({ path, body: b64(text) })));
      assert.equal(calls.length, 0);
      assert.equal(response.statusCode, 403);
      assert.equal(response.body.message ?? response.body.error.message, NOT_VALID);
      assert.equal(logged().reason, 'body has a duplicate top-level key');
    });
  }

  for (const [name, text] of [
    ['a repeated key in a nested object', `{"anthropic_version":"bedrock-2023-05-31","metadata":{"a":1,"a":2},"messages":${HIDDEN}}`],
    ['key text in a string value', `{"anthropic_version":"bedrock-2023-05-31","system":"x\\",\\"messages\\":[]}{","messages":${HIDDEN}}`],
  ]) {
    it(`${name} goes to LangGuard`, async () => {
      const { handler, calls } = setup();
      assert.deepEqual(await handler(httpEvent({ path: invoke, body: b64(text) })), PASS);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].body.params.payload.body, JSON.parse(text));
    });
  }
});

describe('error texts', () => {
  const NOT_VALID = 'Blocked by LangGuard: this is not a valid model request, so it was not sent for a policy check.';
  const UNSUPPORTED = 'Blocked by LangGuard: LangGuard cannot check calls to this inference API, so this call is not allowed.';
  const invoke = `/inference/model/${encodedModel}/invoke`;

  for (const [name, body] of [
    ['no anthropic_version', { inputText: PROMPT, textGenerationConfig: { maxTokenCount: 10 } }],
    ['a number anthropic_version', { ...BEDROCK_BODY, anthropic_version: 20230531 }],
  ]) {
    it(`a bedrock_invoke body with ${name} is blocked with the "not supported" text and no LangGuard call`, async () => {
      const { handler, calls, logged } = setup();
      const response = blockResponse(await handler(httpEvent({ path: invoke, body })));
      assert.equal(calls.length, 0);
      assert.deepEqual(response.body, { message: UNSUPPORTED });
      assert.equal(logged().reason, 'body has no anthropic_version');
    });
  }

  it('a JSON-RPC -32602 from LangGuard is blocked with the "not valid" text', async () => {
    const { handler, logged } = setup({ respond: () => json({ jsonrpc: '2.0', id: 'x', error: { code: -32602, message: 'Invalid params' } }) });
    const response = blockResponse(await handler(httpEvent({ path: invoke, body: BEDROCK_BODY })));
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, { message: NOT_VALID });
    assert.equal(logged().reason, 'JSON-RPC error -32602');
  });
});

describe('LangGuard unavailable', () => {
  const event = httpEvent({ path: `/inference/model/${encodedModel}/invoke-with-response-stream`, body: BEDROCK_BODY });
  const UNAVAILABLE = 'Blocked by LangGuard: the policy check is unavailable, so this model call is not allowed.';

  for (const [name, options] of [
    ['a network error', { respond: () => { throw new TypeError('fetch failed'); } }],
    ['HTTP 503', { respond: () => json({}, 503) }],
    ['a JSON-RPC error', { respond: () => json({ jsonrpc: '2.0', id: 'x', error: { code: -32601 } }) }],
    ['no LANGGUARD_URL', { env: { ...ENV, LANGGUARD_URL: undefined } }],
  ]) {
    it(`${name} blocks the model call with the "unavailable" text`, async () => {
      const { handler } = setup(options);
      const response = blockResponse(await handler(event));
      assert.equal(response.statusCode, 403);
      assert.deepEqual(response.body, { message: UNAVAILABLE });
    });
  }
});

describe('size and binary content', () => {
  const PLACEHOLDER = '[binary content removed by LangGuard]';
  const DATA = 'iVBORw0KGgoAAAANSUhEUg';
  const image = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } });
  const text = { type: 'text', text: PROMPT };
  const turn = (i, size) => ({ role: i % 2 === 0 ? 'user' : 'assistant', content: `turn ${i} ${'x'.repeat(size)}` });

  async function send(path, body) {
    const { handler, calls, logged } = setup();
    assert.deepEqual(await handler(httpEvent({ path, body })), PASS);
    return { payload: calls[0].body.params.payload, logged: logged() };
  }

  it('sends each message of a request larger than 1 MB, with truncated false', async () => {
    const body = { ...BEDROCK_BODY, messages: [...Array.from({ length: 40 }, (_, i) => turn(i, 50_000)), { role: 'user', content: PROMPT }] };
    const { payload, logged } = await send(`/inference/model/${encodedModel}/invoke`, body);
    assert.deepEqual(payload.body, body);
    assert.equal(payload.truncated, false);
    assert.equal(logged.truncated, undefined);
  });

  it('replaces the data of an Anthropic image in each message, keeps the text, and sets truncated', async () => {
    const body = {
      ...BEDROCK_BODY,
      messages: [{ role: 'user', content: [image(DATA)] }, turn(1, 10), { role: 'user', content: [text, image(DATA)] }],
    };
    const { payload, logged } = await send(`/inference/model/${encodedModel}/invoke`, body);
    assert.deepEqual(payload.body, {
      ...BEDROCK_BODY,
      messages: [{ role: 'user', content: [image(PLACEHOLDER)] }, turn(1, 10), { role: 'user', content: [text, image(PLACEHOLDER)] }],
    });
    assert.equal(payload.truncated, true);
    assert.equal(logged.truncated, true);
  });

  it('replaces the data of an image in a tool result and of a document block', async () => {
    const document = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: DATA } };
    const toolResult = (content) => ({ type: 'tool_result', tool_use_id: 't1', content });
    const body = {
      ...MESSAGES_BODY,
      messages: [{ role: 'user', content: [toolResult([{ type: 'text', text: 'screenshot' }, image(DATA)]), document, text] }],
    };
    const { payload } = await send('/inference/v1/messages', body);
    assert.deepEqual(payload.body.messages[0].content, [
      toolResult([{ type: 'text', text: 'screenshot' }, image(PLACEHOLDER)]),
      { ...document, source: { ...document.source, data: PLACEHOLDER } },
      text,
    ]);
    assert.equal(payload.truncated, true);
  });

  it('keeps the text of a plain-text document block', async () => {
    const document = { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'quarterly numbers' } };
    const body = { ...MESSAGES_BODY, messages: [{ role: 'user', content: [document, text] }] };
    const { payload } = await send('/inference/v1/messages', body);
    assert.deepEqual(payload.body.messages[0].content, [document, text]);
    assert.equal(payload.truncated, false);
  });

  it('replaces an OpenAI image data URL and keeps an image web URL', async () => {
    const web = { type: 'image_url', image_url: { url: 'https://images.example.com/chart.png' } };
    const content = [text, { type: 'image_url', image_url: { url: `data:image/png;base64,${DATA}`, detail: 'high' } }, web];
    const { payload } = await send('/inference/v1/chat/completions', { ...CHAT_BODY, messages: [{ role: 'user', content }] });
    assert.deepEqual(payload.body.messages[0].content, [text, { type: 'image_url', image_url: { url: PLACEHOLDER, detail: 'high' } }, web]);
    assert.equal(payload.truncated, true);
  });

  it('keeps an image with a URL source and sets truncated false', async () => {
    const linked = { type: 'image', source: { type: 'url', url: 'https://images.example.com/chart.png' } };
    const body = { ...BEDROCK_BODY, messages: [{ role: 'user', content: [text, linked] }] };
    const { payload } = await send(`/inference/model/${encodedModel}/invoke`, body);
    assert.deepEqual(payload.body, body);
    assert.equal(payload.truncated, false);
  });

  it('follows a LangGuard 413 with the "too large" block', async () => {
    const { handler } = setup({ respond: () => json({}, 413) });
    const response = blockResponse(await handler(httpEvent({ path: `/inference/model/${encodedModel}/invoke`, body: BEDROCK_BODY })));
    assert.equal(response.statusCode, 403);
    assert.deepEqual(response.body, {
      message: 'Blocked by LangGuard: the model request is too large for the policy check, so it is not allowed.',
    });
  });
});

describe('caller identity of a model call', () => {
  it('resolves the SigV4 access key ID of a Bedrock call with the key map and sends the user', async () => {
    const asked = [];
    const { handler, calls, logged } = setup({
      env: { ...ENV, LANGGUARD_AUTHORIZER: 'AWS_IAM', LANGGUARD_USER_CLAIM: undefined },
      lookupCaller: async (id) => {
        asked.push(id);
        return { outcome: 'hit', userName: 'jane@corp.example' };
      },
    });
    const event = httpEvent({
      path: `/inference/model/${encodedModel}/invoke`,
      body: BEDROCK_BODY,
      headers: { Authorization: SIGV4, 'Content-Type': 'application/json' },
    });
    await handler(event);
    assert.deepEqual(asked, [KEY_ID]);
    assert.equal(calls[0].body.params.config.langguard.user_id, 'jane@corp.example');
    assert.equal(logged().caller, 'hit');
  });

  it('sends no user when the key is not in the key map', async () => {
    const { handler, calls, logged } = setup({
      env: { ...ENV, LANGGUARD_AUTHORIZER: 'AWS_IAM' },
      lookupCaller: async () => ({ outcome: 'miss' }),
    });
    await handler(httpEvent({ path: '/inference/v1/messages', body: MESSAGES_BODY, headers: { Authorization: SIGV4 } }));
    assert.equal(calls[0].body.params.config.langguard.user_id, undefined);
    assert.equal(logged().caller, 'miss');
  });
});

describe('log line of a model call', () => {
  it('names the route, dialect and model, and has no body, prompt, header or key', async () => {
    const { handler, lines } = setup({ respond: deny });
    await handler(httpEvent({
      path: `/inference/model/${encodedModel}/invoke`,
      body: BEDROCK_BODY,
      headers: { Authorization: SIGV4, traceparent: TRACEPARENT },
    }));
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.phase, 'request');
    assert.equal(entry.route, 'invoke');
    assert.equal(entry.dialect, 'bedrock_invoke');
    assert.equal(entry.model, MODEL_ID);
    assert.equal(entry.outcome, 'block');
    assert.equal(entry.traceId, TRACE_ID);
    for (const secret of [API_KEY, PROMPT, 'coding assistant', 'Signature=', KEY_ID, 'Prompt has PII']) {
      assert.ok(!lines[0].includes(secret), secret);
    }
  });
});
