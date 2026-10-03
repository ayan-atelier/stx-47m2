export const VERSION = '0.1.0';
export const SECRET_SLOT = 'yantai:novel:custom-api-key:v1';

export const DEFAULT_PROMPT = `你是小说编辑，不是续写模型。请对输入原稿做“保真去模板化”编辑。

硬约束：
1. 不新增、不删除、不调换事件、人物、事实、时间线、因果关系或设定。
2. 不改变叙事视角、时态、人物意图、角色对白口吻和专有名词。
3. 不把留白、断裂句、故意重复、口语停顿或类型化表达自动改得平滑。
4. 不凭空添加异域文化细节、神话名词、隐喻、心理解释或总结。
5. 保留原稿段落顺序与段落数量；只在必要时调整句式、节奏、重复和套话。
6. 删除模板化开头、模板化收束、无意义的“仿佛／不禁／缓缓”、平均句长、过度解释和空泛情绪总结，但保留确有作用的词语。
7. 对话按角色保留，不要让所有角色都变成作者的同一种声音。
8. 输入中的 XML/HTML 标签、状态标签和代码标记必须原样保留。

输出要求：只输出修订后的原文，不解释修改过程，不加代码围栏。无法确定是否应该修改时，保留原句。`;

export const DEFAULTS = Object.freeze({
  enabled: true,
  autoCorrect: true,
  autoApply: false,
  defaultVersion: 'revised',
  apiUrl: '',
  model: '',
  temperature: 0.35,
  maxTokens: 8192,
  timeoutSeconds: 180,
  prompt: DEFAULT_PROMPT,
  genreBible: '',
  voiceProfile: '',
});

const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);

export function mergeSettings(target, patch) {
  if (!isObject(patch)) return target;
  for (const [key, value] of Object.entries(patch)) {
    if (unsafe.has(key) || value === undefined) continue;
    if (isObject(value)) target[key] = mergeSettings(isObject(target[key]) ? target[key] : {}, value);
    else target[key] = Array.isArray(value) ? structuredClone(value) : value;
  }
  return target;
}

export function normalizeSettings(value = {}) {
  const next = mergeSettings({ ...DEFAULTS }, value);
  next.enabled = next.enabled !== false;
  next.autoCorrect = next.autoCorrect !== false;
  next.autoApply = next.autoApply === true;
  next.defaultVersion = next.defaultVersion === 'original' ? 'original' : 'revised';
  next.temperature = Number.isFinite(Number(next.temperature)) ? Math.max(0, Math.min(2, Number(next.temperature))) : DEFAULTS.temperature;
  next.maxTokens = Number.isInteger(Number(next.maxTokens)) ? Math.max(512, Math.min(65536, Number(next.maxTokens))) : DEFAULTS.maxTokens;
  next.timeoutSeconds = Number.isInteger(Number(next.timeoutSeconds)) ? Math.max(30, Math.min(900, Number(next.timeoutSeconds))) : DEFAULTS.timeoutSeconds;
  for (const key of ['apiUrl', 'model', 'prompt', 'genreBible', 'voiceProfile']) if (typeof next[key] !== 'string') next[key] = String(next[key] ?? '');
  return next;
}

export function hash(value) {
  let h = 2166136261;
  for (const char of String(value ?? '')) { h ^= char.codePointAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function normalizeApiUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new Error('请填写完整 API 地址，例如 https://你的服务地址/v1。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址应为 http/https 地址，不带账号、查询参数或片段。');
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses)\/?$/, '').replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

export function splitParagraphs(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  return normalized.split(/\n{2,}/).map(value => value.trim()).filter(Boolean);
}

export function buildSegments(original, revised) {
  const raw = splitParagraphs(original), edit = splitParagraphs(revised);
  const count = Math.max(raw.length, edit.length);
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    original: raw[index] ?? '',
    revised: edit[index] ?? '',
  }));
}

export function buildPrompt(config, original) {
  const sections = [String(config.prompt || DEFAULT_PROMPT).trim()];
  if (String(config.genreBible || '').trim()) sections.push(`\n【本项目的题材与叙事约束】\n${config.genreBible.trim()}\n只保留原稿中已经出现的内容，不凭空添加设定。`);
  if (String(config.voiceProfile || '').trim()) sections.push(`\n【作者声音参考】\n${config.voiceProfile.trim()}\n仅用于校准语言表面，不得改变剧情和人物。`);
  sections.push(`\n【原稿开始】\n${String(original)}\n【原稿结束】`);
  return sections.join('\n');
}

export function apiPayload(config, messages, key = '') {
  if (!String(config.model || '').trim()) throw new Error('请先填写纠偏模型名称。');
  const extra = {};
  return {
    chat_completion_source: 'custom',
    custom_url: normalizeApiUrl(config.apiUrl),
    model: config.model.trim(), messages, stream: false, n: 1,
    temperature: config.temperature, max_tokens: config.maxTokens,
    custom_include_headers: JSON.stringify({ Authorization: key ? `Bearer ${key}` : '' }),
    custom_include_body: JSON.stringify(extra),
    custom_exclude_body: JSON.stringify([]),
  };
}

function contentFromChoice(choice) {
  const content = choice?.message?.content ?? choice?.text;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(item => item?.type === 'text').map(item => item.text || '').join('');
  return '';
}

export function extractText(data, context) {
  if (data?.error) throw new Error('纠偏 API 返回错误，请检查连接、模型和额度。');
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length' || data?.stop_reason === 'max_tokens' || data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('纠偏输出达到长度上限，原稿已保留。');
  if (choice?.message?.refusal) throw new Error('纠偏模型拒绝处理，原稿已保留。');
  let text = contentFromChoice(choice);
  if (!text) text = context?.extractMessageFromData?.(data, 'openai') || '';
  if (!String(text).trim()) throw new Error('纠偏 API 没有返回可读取的正文，原稿已保留。');
  text = String(text).trim().replace(/^```(?:text|markdown)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(text);
    const candidate = parsed?.revised ?? parsed?.text ?? parsed?.content;
    if (typeof candidate === 'string' && candidate.trim()) text = candidate.trim();
  } catch { /* Plain text is the preferred response format. */ }
  return text;
}

export function buildMessages(config, original) {
  return [
    { role: 'system', content: buildPrompt(config, original) },
    { role: 'user', content: '请按系统规则处理上面的原稿。只返回修订后的正文。' },
  ];
}

export function makeMeta({ original, revised = '', status = 'pending', config = {} } = {}) {
  const raw = String(original ?? '');
  const result = { schema: 1, original: raw, originalHash: hash(raw), status, createdAt: new Date().toISOString(), activeVersion: 'original', revisions: [] };
  if (revised) result.revisions.push({ id: `rev-${Date.now().toString(36)}`, kind: 'deai', text: revised, hash: hash(revised), styleProfile: hash(config.voiceProfile || ''), createdAt: new Date().toISOString(), segments: buildSegments(raw, revised) });
  return result;
}

export function latestRevision(meta) { return Array.isArray(meta?.revisions) && meta.revisions.length ? meta.revisions.at(-1) : null; }

export function activeText(meta) {
  const revision = latestRevision(meta);
  return meta?.activeVersion === 'revised' && revision ? revision.text : String(meta?.original ?? '');
}
