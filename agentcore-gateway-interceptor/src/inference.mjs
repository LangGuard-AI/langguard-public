export const INVOKE_MODEL_METHOD = 'interceptor/invoke_model';
const INFERENCE_PREFIX = 'inference';
const MAX_LOGGED_MODEL = 256;
const CONTROL_CHARS = /\p{Cc}/gu;

/**
 * @typedef {'bedrock_invoke' | 'anthropic_messages' | 'openai_chat'} Dialect
 * @typedef {{ dialect: Dialect, model: string, stream: boolean, body: Record<string, unknown> }} ModelRequest
 * @typedef {{ phase: 'request' | 'response', route: string, dialect?: Dialect, model?: string }} RouteLog
 * @typedef {(
 *   | { kind: 'pass', log: RouteLog, reason: string }
 *   | { kind: 'block', log: RouteLog, format: Dialect, cause: 'unsupported' | 'invalid', reason: string }
 *   | { kind: 'evaluate', log: RouteLog, request: ModelRequest }
 * )} HttpClassification
 * @typedef {(
 *   | { kind: 'evaluate', dialect: Dialect, stream: boolean | 'body' }
 *   | { kind: 'pass', reason: string }
 *   | { kind: 'block', format: Dialect }
 * )} RouteAction
 */

const MODEL = Symbol('model');
const ANY_SEGMENTS = Symbol('any segments');

/**
 * The AWS documentation does not show if the REQUEST event path keeps the `/inference` prefix, so the evaluate and
 * count-tokens rows match the path with or without it. `MODEL` is one or more raw segments (an application inference
 * profile ARN has a `/`).
 * @type {{ route: string, method: string, path: (string | symbol)[], inferenceOnly?: true, action: RouteAction }[]}
 */
const ROUTES = [
  { route: 'invoke', method: 'POST', path: ['model', MODEL, 'invoke'], action: { kind: 'evaluate', dialect: 'bedrock_invoke', stream: false } },
  { route: 'invoke_stream', method: 'POST', path: ['model', MODEL, 'invoke-with-response-stream'], action: { kind: 'evaluate', dialect: 'bedrock_invoke', stream: true } },
  { route: 'count_tokens', method: 'POST', path: ['model', MODEL, 'count-tokens'], action: { kind: 'pass', reason: 'no model invocation' } },
  { route: 'messages', method: 'POST', path: ['v1', 'messages'], action: { kind: 'evaluate', dialect: 'anthropic_messages', stream: 'body' } },
  { route: 'chat_completions', method: 'POST', path: ['v1', 'chat', 'completions'], action: { kind: 'evaluate', dialect: 'openai_chat', stream: 'body' } },
  { route: 'read', method: 'GET', path: [ANY_SEGMENTS], inferenceOnly: true, action: { kind: 'pass', reason: 'no model invocation' } },
  { route: 'unsupported', method: 'POST', path: ['model', ANY_SEGMENTS], inferenceOnly: true, action: { kind: 'block', format: 'bedrock_invoke' } },
  { route: 'unsupported', method: 'POST', path: ['v1', 'messages', ANY_SEGMENTS], inferenceOnly: true, action: { kind: 'block', format: 'anthropic_messages' } },
  { route: 'unsupported', method: '*', path: [ANY_SEGMENTS], inferenceOnly: true, action: { kind: 'block', format: 'openai_chat' } },
];

const ERROR_FORMATS = {
  bedrock_invoke: { statusCode: 451, headers: { 'x-amzn-ErrorType': 'AccessDeniedException' }, body: (message) => ({ message }) },
  anthropic_messages: { statusCode: 403, body: (message) => ({ type: 'error', error: { type: 'permission_error', message } }) },
  openai_chat: { statusCode: 403, body: (message) => ({ error: { message, type: 'permission_denied' } }) },
};

export const MODEL_BLOCK_TEXT = {
  unavailable: 'Blocked by LangGuard: the policy check is unavailable, so this model call is not allowed.',
  invalid: 'Blocked by LangGuard: this is not a valid model request, so it was not sent for a policy check.',
  unsupported: 'Blocked by LangGuard: LangGuard cannot check calls to this inference API, so this call is not allowed.',
  too_large: 'Blocked by LangGuard: the model request is too large for the policy check, so it is not allowed.',
};

export const HTTP_PASS = Object.freeze({ interceptorOutputVersion: '1.0', http: Object.freeze({}) });

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const loggedModel = (model) => model.replace(CONTROL_CHARS, '').slice(0, MAX_LOGGED_MODEL);

/** @returns {{ raw: string[], names: string[] } | undefined} */
function normalizePath(path) {
  const raw = [];
  const names = [];
  for (const segment of path.split(/[?#]/)[0].split('/')) {
    let name;
    try {
      name = decodeURIComponent(segment);
    } catch {
      return undefined;
    }
    if (name === '' || name === '.') continue;
    if (name === '..') {
      raw.pop();
      names.pop();
      continue;
    }
    raw.push(segment);
    names.push(name.toLowerCase());
  }
  return { raw, names };
}

/** @returns {{ model?: string } | undefined} */
function matchPath(pattern, { raw, names }) {
  const at = pattern.indexOf(MODEL);
  if (at === -1) {
    const rest = pattern.at(-1) === ANY_SEGMENTS;
    const fixed = rest ? pattern.slice(0, -1) : pattern;
    const fits = rest ? names.length >= fixed.length : names.length === fixed.length;
    return fits && fixed.every((p, i) => p === names[i]) ? {} : undefined;
  }
  const before = pattern.slice(0, at);
  const after = pattern.slice(at + 1);
  const end = names.length - after.length;
  if (end - at < 1) return undefined;
  if (!before.every((p, i) => p === names[i]) || !after.every((p, i) => p === names[end + i])) return undefined;
  return { model: decodeURIComponent(raw.slice(at, end).join('/')) };
}

/** JSON.parse keeps the last value of a repeated key, and another reader can keep the first. */
function hasDuplicateTopLevelKey(text) {
  const keys = new Set();
  let depth = 0;
  let atKey = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      if (depth === 1 && atKey) {
        const key = JSON.parse(text.slice(i, end + 1));
        if (keys.has(key)) return true;
        keys.add(key);
        atKey = false;
      }
      i = end;
    } else if (c === '{' || c === '[') {
      depth++;
      if (depth === 1) atKey = true;
    } else if (c === '}' || c === ']') {
      depth--;
    } else if (c === ',' && depth === 1) {
      atKey = true;
    }
  }
  return false;
}

/** @returns {{ body: Record<string, unknown> } | { reason: string }} */
function decodeBody(body) {
  if (typeof body !== 'string' || body === '') return { reason: 'body is not a JSON object' };
  const text = Buffer.from(body, 'base64').toString('utf8');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { reason: 'body is not a JSON object' };
  }
  if (!isObject(parsed)) return { reason: 'body is not a JSON object' };
  return hasDuplicateTopLevelKey(text) ? { reason: 'body has a duplicate top-level key' } : { body: parsed };
}

/**
 * The payload is the same for HTTP, passthrough and inference targets.
 * @param {boolean} inferenceGateway
 * @returns {HttpClassification}
 */
export function classifyHttp(http, inferenceGateway) {
  if (http.gatewayResponse != null) {
    return { kind: 'pass', log: { phase: 'response', route: 'response' }, reason: 'response event' };
  }
  const request = isObject(http.gatewayRequest) ? http.gatewayRequest : {};
  if (typeof request.path !== 'string' || typeof request.httpMethod !== 'string') {
    return {
      kind: 'block',
      log: { phase: 'request', route: 'unknown' },
      format: 'bedrock_invoke',
      cause: 'invalid',
      reason: 'gatewayRequest has no path or httpMethod',
    };
  }
  const segments = normalizePath(request.path);
  if (!segments) {
    return {
      kind: 'block',
      log: { phase: 'request', route: 'unknown' },
      format: 'bedrock_invoke',
      cause: 'invalid',
      reason: 'path has a bad percent escape',
    };
  }
  const prefixed = segments.names[0] === INFERENCE_PREFIX;
  const subPath = prefixed ? { raw: segments.raw.slice(1), names: segments.names.slice(1) } : segments;
  const inferencePath = prefixed || inferenceGateway;
  const method = request.httpMethod.toUpperCase();
  let match;
  const row = ROUTES.find(
    (r) => (inferencePath || !r.inferenceOnly) && (r.method === '*' || r.method === method) && (match = matchPath(r.path, subPath)),
  );
  if (!row) return { kind: 'pass', log: { phase: 'request', route: 'other' }, reason: 'http target' };
  const { route, action } = row;
  if (action.kind === 'pass') return { kind: 'pass', log: { phase: 'request', route }, reason: action.reason };
  if (action.kind === 'block') {
    return { kind: 'block', log: { phase: 'request', route }, format: action.format, cause: 'unsupported', reason: 'inference API not supported' };
  }

  const { dialect } = action;
  const decoded = decodeBody(request.body);
  const body = 'body' in decoded ? decoded.body : undefined;
  const model = match.model ?? body?.model;
  const log = { phase: 'request', route, dialect, ...(typeof model === 'string' ? { model: loggedModel(model) } : {}) };
  if (!body) return { kind: 'block', log, format: dialect, cause: 'invalid', reason: decoded.reason };
  if (typeof model !== 'string' || model === '') {
    return { kind: 'block', log, format: dialect, cause: 'invalid', reason: 'request names no model' };
  }
  if (dialect === 'bedrock_invoke' && typeof body.anthropic_version !== 'string') {
    return { kind: 'block', log, format: dialect, cause: 'unsupported', reason: 'body has no anthropic_version' };
  }
  const stream = action.stream === 'body' ? body.stream === true : action.stream;
  return { kind: 'evaluate', log, request: { dialect, model, stream, body } };
}

const BINARY_PLACEHOLDER = '[binary content removed by LangGuard]';

function withoutBinaryData(block) {
  if (!isObject(block)) return block;
  if ((block.type === 'image' || block.type === 'document') && isObject(block.source) && block.source.type !== 'text' && typeof block.source.data === 'string') {
    return { ...block, source: { ...block.source, data: BINARY_PLACEHOLDER } };
  }
  const url = isObject(block.image_url) ? block.image_url.url : undefined;
  if (block.type === 'image_url' && typeof url === 'string' && url.startsWith('data:')) {
    return { ...block, image_url: { ...block.image_url, url: BINARY_PLACEHOLDER } };
  }
  if (block.type === 'tool_result' && Array.isArray(block.content)) {
    const content = block.content.map(withoutBinaryData);
    return content.every((b, i) => b === block.content[i]) ? block : { ...block, content };
  }
  return block;
}

function messageWithoutBinaryData(message) {
  if (!isObject(message) || !Array.isArray(message.content)) return message;
  const content = message.content.map(withoutBinaryData);
  return content.every((b, i) => b === message.content[i]) ? message : { ...message, content };
}

/**
 * @param {ModelRequest} request
 * @param {{ config: object, context?: object }} caller
 */
export function invokeModelParams({ dialect, model, stream, body }, { config, context }) {
  const messages = Array.isArray(body.messages) ? body.messages.map(messageWithoutBinaryData) : undefined;
  const truncated = messages !== undefined && messages.some((m, i) => m !== body.messages[i]);
  return {
    payload: { dialect, model, stream, body: truncated ? { ...body, messages } : body, truncated },
    config,
    ...(context !== undefined ? { context } : {}),
  };
}

/**
 * The gateway then calls no target.
 * @param {Dialect} format
 * @param {string} text
 */
export function httpBlock(format, text) {
  const { statusCode, headers, body } = ERROR_FORMATS[format];
  return {
    interceptorOutputVersion: '1.0',
    http: {
      transformedGatewayResponse: {
        statusCode,
        contentType: 'application/json',
        ...(headers ? { headers } : {}),
        body: Buffer.from(JSON.stringify(body(text))).toString('base64'),
      },
    },
  };
}
