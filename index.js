import { createHost } from './src/host.js';
import { buildMessages, extractText, hash, latestRevision, makeMeta, normalizeSettings, apiPayload, buildSegments } from './src/core.js';

const VERSION = '0.1.1';
const SETTINGS_KEY = 'yantaiNovel';
const SECRET_SLOT = 'yantai:novel:custom-api-key:v1';
const cleanups = [];
let host, panel, pane = 'chat', alive = false, busy = new Map(), selectedIndex = null, menuItem = null;

const ctx = () => host?.context?.();
function settings() {
  const c = ctx();
  if (!c) return normalizeSettings();
  if (!c.extensionSettings || typeof c.extensionSettings !== 'object') c.extensionSettings = {};
  c.extensionSettings[SETTINGS_KEY] = normalizeSettings(c.extensionSettings[SETTINGS_KEY]);
  return c.extensionSettings[SETTINGS_KEY];
}
function saveSettings() { ctx()?.saveSettingsDebounced?.(); }
function readKey() { try { return localStorage.getItem(SECRET_SLOT) || ''; } catch { return ''; } }
function writeKey(value) { try { if (value) localStorage.setItem(SECRET_SLOT, value); else localStorage.removeItem(SECRET_SLOT); } catch { throw new Error('当前浏览器无法保存 API Key。'); } }
function el(tag, text = '', className = '') { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (className) e.className = className; return e; }
function button(text, action, primary = false) { const b = el('button', text, `yt-novel-button${primary ? ' primary' : ''}`); b.type = 'button'; b.addEventListener('click', action); return b; }
function section(title, detail = '') { const s = el('section', '', 'yt-novel-section'); s.append(el('h3', title)); if (detail) s.append(el('p', detail, 'muted')); return s; }
function input(label, value, type = 'text') { const l = el('label', '', 'yt-novel-field'); l.append(el('span', label)); const i = el(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') i.type = type; i.value = value ?? ''; l.append(i); return { wrap:l, input:i }; }
function toggle(label, checked, handler) { const l = el('label', '', 'yt-novel-toggle'); const i = el('input'); i.type = 'checkbox'; i.checked = checked; i.addEventListener('change', handler); l.append(i, el('span', label)); return { wrap:l, input:i }; }

function ensurePanel() {
  if (panel?.isConnected) return panel;
  panel = el('dialog', '', 'yt-novel-dialog'); panel.id = 'yt-novel-dialog';
  const header = el('header', '', 'yt-novel-header'); const title = el('div'); title.append(el('small', `砚台 · v${VERSION}`), el('h2', '小说生产')); const close = button('×', () => panel.close()); close.setAttribute('aria-label', '关闭小说生产'); header.append(title, close);
  const body = el('div', '', 'yt-novel-body'); panel.append(header, body); document.body.append(panel); panel._body = body;
  panel.addEventListener('click', event => { if (event.target === panel) panel.close(); });
  return panel;
}
function openPanel() { ensurePanel(); if (!panel.open) panel.showModal(); render(); }
function currentMessages() { return host.currentChat()?.messages || []; }
function messageMeta(message) { return message?.extra?.yantai_novel || null; }
function writeMeta(message, meta) { message.extra = { ...(message.extra || {}), yantai_novel: meta }; }
function revisions(meta) { return Array.isArray(meta?.revisions) ? meta.revisions : []; }
function latestText(meta) { return latestRevision(meta)?.text || ''; }

async function correctMessage(message, index, { force = false } = {}) {
  const config = settings();
  if (!config.enabled || !config.autoCorrect && !force) return false;
  const old = messageMeta(message);
  const current = String(message?.mes || '');
  if (!current.trim()) return false;
  const currentHash = hash(current);
  const known = old && [old.originalHash, ...revisions(old).map(revision => revision.hash)].includes(currentHash);
  const original = known ? String(old.original || current) : current;
  if (!force && old?.originalHash === hash(original) && latestRevision(old)) return false;
  const key = `${host.currentChat()?.key}:${index}:${hash(original)}`;
  if (busy.has(key)) return busy.get(key);
  const job = (async () => {
    const meta = old?.originalHash === hash(original) ? old : makeMeta({ original, config });
    try {
      meta.status = 'processing'; meta.error = ''; meta.updatedAt = new Date().toISOString(); writeMeta(message, meta); await host.saveChat(); render();
      const payload = apiPayload(config, buildMessages(config, original), readKey());
      const data = await host.request(payload, config.timeoutSeconds);
      const revised = extractText(data, ctx());
      const next = { ...meta, status: 'ready', error: '', updatedAt: new Date().toISOString(), revisions: [...revisions(meta), { id:`rev-${Date.now().toString(36)}`, kind:'deai', text:revised, hash:hash(revised), styleProfile:hash(config.voiceProfile || ''), createdAt:new Date().toISOString(), segments: buildSegments(original, revised) }] };
      writeMeta(message, next); await host.saveChat();
      if (config.autoApply) await applyVersion(message, next, config.defaultVersion === 'revised' ? 'revised' : 'original', false);
      host.toast('本轮小说原稿已完成去 AI 味修订。', 'success'); return true;
    } catch (error) {
      meta.status = 'failed'; meta.error = String(error.message || error); meta.updatedAt = new Date().toISOString(); writeMeta(message, meta); await host.saveChat(); host.toast(meta.error, 'error'); return false;
    } finally { busy.delete(key); render(); }
  })();
  busy.set(key, job); return job;
}

async function applyVersion(message, meta, version, reload = true) {
  const revision = latestRevision(meta);
  const text = version === 'revised' && revision ? revision.text : meta.original;
  message.mes = text;
  meta.activeVersion = version === 'revised' && revision ? 'revised' : 'original'; meta.updatedAt = new Date().toISOString(); writeMeta(message, meta);
  await host.saveChat();
  if (reload) await host.refreshChat?.();
  render();
}

async function copy(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
    await navigator.clipboard.writeText(String(text || ''));
    host.toast('已复制到剪贴板。', 'success');
  } catch { host.toast('复制失败，请长按文本复制。', 'error'); }
}
function renderCompare(container, message, index, meta) {
  const revision = latestRevision(meta);
  if (!revision) {
    container.append(el('p', meta.status === 'processing' ? '修订稿生成中……' : meta.error || '这条回复还没有修订稿。', 'muted'));
    if (meta.status !== 'processing') container.append(button('重试纠偏', () => void correctMessage(message, index, { force:true }), true));
    return;
  }
  const bar = el('div', '', 'yt-novel-actions'); bar.append(button('复制原版', () => copy(meta.original)), button('复制去AI味版', () => copy(revision.text)), button('采用原版', () => void applyVersion(message, meta, 'original')), button('采用去AI味版', () => void applyVersion(message, meta, 'revised'), true), button('重新纠偏', () => void correctMessage(message, index, { force:true })));
  container.append(bar);
  const mode = settings().defaultVersion;
  const tabs = el('div', '', 'yt-novel-switch'); const showOriginal = button('原版', () => { original.hidden=false; revised.hidden=true; }); const showRevised = button('去AI味版', () => { original.hidden=true; revised.hidden=false; }); const showBoth = button('对照', () => { original.hidden=false; revised.hidden=false; }); tabs.append(showOriginal, showRevised, showBoth); container.append(tabs);
  const pair = el('div', '', 'yt-novel-pair'); const original = el('article', '', 'yt-novel-version'); original.append(el('h4', '原版')); original.append(el('div', meta.original)); const revised = el('article', '', 'yt-novel-version revised'); revised.append(el('h4', '去AI味版')); revised.append(el('div', revision.text)); pair.append(original, revised); container.append(pair);
  original.hidden = mode !== 'original'; revised.hidden = mode === 'original';
}

function renderChat(container) {
  const chat = host.currentChat(); if (!chat) return container.append(el('p', '请先打开一个角色聊天。', 'muted'));
  container.append(el('p', `${chat.name} · 自动纠偏${settings().autoCorrect ? '已开启' : '已关闭'}`, 'muted'));
  const lastIndex = chat.messages.length - 1, last = chat.messages[lastIndex];
  if (last && !last.is_user && !last.is_system && String(last.mes || '').trim() && !latestRevision(messageMeta(last))) {
    container.append(button('立即纠偏最近一条回复', () => void correctMessage(last, lastIndex, { force:true }), true));
  }
  const rows = chat.messages.map((message, index) => ({ message, index, meta:messageMeta(message) })).filter(row => row.meta);
  if (!rows.length) return container.append(el('p', '当前聊天还没有已保存的小说版本。生成一条回复后，这里会自动出现原版和修订版。', 'muted'));
  const list = el('div', '', 'yt-novel-list'); rows.reverse().forEach(row => {
    const item = el('details', '', 'yt-novel-item'); if (row.index === selectedIndex) item.open = true;
    const label = el('summary'); const state = row.meta.status === 'ready' ? '已完成' : row.meta.status === 'processing' ? '处理中' : row.meta.status === 'failed' ? '失败' : '待处理'; label.append(el('b', `第 ${row.index + 1} 条回复`), el('small', `${state} · ${row.meta.activeVersion === 'revised' ? '当前为去AI味版' : '当前为原版'}`)); item.append(label);
    const body = el('div', '', 'yt-novel-item-body'); body.append(el('p', String(row.meta.original || '').slice(0, 160) + (String(row.meta.original || '').length > 160 ? '…' : ''), 'muted')); renderCompare(body, row.message, row.index, row.meta); item.append(body); list.append(item);
  }); container.append(list);
}

function renderSettings(container) {
  const config = settings(); const info = section('纠偏 API', '使用酒馆的自定义聊天补全通道，密钥只保存在当前浏览器。');
  const fields = [input('API 地址（可填到 /v1 或 /chat/completions）', config.apiUrl, 'url'), input('模型名称', config.model), input('API Key', readKey()), input('温度', config.temperature, 'number'), input('最大输出 tokens', config.maxTokens, 'number'), input('超时秒数', config.timeoutSeconds, 'number')];
  fields[2].input.type = 'password'; fields[2].input.autocomplete = 'off'; fields.forEach(f => info.append(f.wrap));
  info.append(toggle('开启小说生产扩展', config.enabled, event => { config.enabled=event.target.checked; saveSettings(); }), toggle('每次主回复完成后自动纠偏', config.autoCorrect, event => { config.autoCorrect=event.target.checked; saveSettings(); }), toggle('修订完成后自动采用默认版本', config.autoApply, event => { config.autoApply=event.target.checked; saveSettings(); }));
  const save = button('保存 API 设置', () => { config.apiUrl=fields[0].input.value.trim(); config.model=fields[1].input.value.trim(); config.temperature=Number(fields[3].input.value); config.maxTokens=Number(fields[4].input.value); config.timeoutSeconds=Number(fields[5].input.value); writeKey(fields[2].input.value.trim()); saveSettings(); host.toast('小说生产 API 设置已保存。', 'success'); }); info.append(save); container.append(info);
  const style = section('项目文风', '题材规则和作者声音会传给纠偏 API。建议每个作品单独保存一份，不要塞进长期记忆。');
  const genre=input('题材与叙事约束（genre bible）', config.genreBible, 'textarea'); genre.input.rows=8; const voice=input('作者声音与示例段落（voice profile）', config.voiceProfile, 'textarea'); voice.input.rows=12; style.append(genre.wrap, voice.wrap, button('保存项目文风', () => { config.genreBible=genre.input.value; config.voiceProfile=voice.input.value; saveSettings(); host.toast('项目文风已保存。', 'success'); }, true)); container.append(style);
  const view=section('显示与版本', '原版永远保存在消息元数据里；“采用某版本”才会改变酒馆当前正文。'); const select=el('select', '', 'yt-novel-select'); [['revised','默认查看去AI味版'],['original','默认查看原版']].forEach(([value,label])=>{const o=el('option',label);o.value=value;select.append(o);}); select.value=config.defaultVersion; select.addEventListener('change',()=>{config.defaultVersion=select.value;saveSettings();}); const label=el('label','','yt-novel-field');label.append(el('span','默认查看版本'),select);view.append(label);container.append(view);
}

function render() { if (!panel?.isConnected || !panel.open) return; const body=panel._body; body.replaceChildren(); const nav=el('nav','','yt-novel-tabs'); [['chat','当前版本'],['settings','API 与文风']].forEach(([key,label])=>{const b=button(label,()=>{pane=key;render();});b.setAttribute('aria-selected',String(pane===key));nav.append(b);}); body.append(nav); const content=el('main','','yt-novel-content');body.append(content); if(pane==='settings')renderSettings(content);else renderChat(content); }
function installMenu() { const parent=document.querySelector('#options .options-content'); if(!parent || document.getElementById('yt-novel-menu')) return; const item=el('a','','yt-native-entry interactable');item.id='yt-novel-menu';item.role='button';item.tabIndex=0;item.append(el('i','','fa-lg fa-solid fa-pen-nib'),el('span','小说生产'));item.addEventListener('click',event=>{event.preventDefault();document.getElementById('options_button')?.click();openPanel();});parent.prepend(item); menuItem=item; }
async function processLatest() { const chat=host.currentChat(); if(!chat || chat.isGroup || !settings().enabled) return; const index=chat.messages.length-1, message=chat.messages[index]; if(!message || message.is_user || message.is_system || !String(message.mes||'').trim()) return; await correctMessage(message,index); }
function hook(name, handler) { cleanups.push(host.on(name,handler)); }
function start() { if(alive) return; alive=true; host=createHost(); installMenu(); hook('APP_READY',installMenu); hook('GENERATION_ENDED',()=>{setTimeout(()=>void processLatest(),900);}); hook('CHAT_CHANGED',()=>{selectedIndex=null;render();}); hook('MESSAGE_EDITED',()=>render()); hook('MESSAGE_SWIPED',()=>render()); const observer=new MutationObserver(()=>installMenu()); observer.observe(document.body,{childList:true,subtree:true}); cleanups.push(()=>observer.disconnect()); }
function stop() { alive=false; while(cleanups.length) cleanups.pop()?.(); menuItem?.remove(); menuItem=null; panel?.remove();panel=null;busy.clear(); }
export function onEnable(){start();}
export function onDisable(){stop();}


function installSettingsEntry() {
  const parent = document.querySelector('#extensions_settings2, #extensions_settings');
  if (!parent || document.getElementById('yt-novel-settings-entry')) return;
  const wrap = el('div', '', 'inline-drawer yt-novel-settings-entry');
  wrap.id = 'yt-novel-settings-entry';
  const header = el('div', '', 'inline-drawer-header');
  header.append(el('b', '砚台 · 小说生产'));
  const content = el('div', '', 'inline-drawer-content');
  content.append(el('p', '主回复完成后保留原版，并用第二 API 生成去 AI 味版。API、题材规则和作者声音在面板内配置。', 'description muted'));
  content.append(button('打开小说生产', openPanel, true));
  wrap.append(header, content);
  parent.append(wrap);
}
const settingsObserver = new MutationObserver(() => installSettingsEntry());
settingsObserver.observe(document.body, { childList: true, subtree: true });
installSettingsEntry();
if (globalThis.SillyTavern?.getContext) onEnable();
else window.addEventListener('load', onEnable, { once: true });


// Reuse SillyTavern's native extension drawer so the entry works with custom themes.
function installSettingsEntry() {
  const parent = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
  if (!parent || document.getElementById('yt-novel-settings-entry')) return;
  const block = el('div', '', 'extension_container yt-plugin-settings');
  block.id = 'yt-novel-settings-entry';
  const drawer = el('div', '', 'inline-drawer');
  const header = el('div', '', 'inline-drawer-toggle inline-drawer-header');
  header.tabIndex = 0;
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', 'false');
  header.setAttribute('aria-controls', 'yt-novel-settings-content');
  const icon = el('div', '', 'fa-solid fa-circle-chevron-down inline-drawer-icon down');
  icon.setAttribute('aria-hidden', 'true');
  header.append(el('b', '砚台 · 小说生产'), icon);
  header.addEventListener('click', () => header.setAttribute('aria-expanded', String(icon.classList.contains('down'))));
  header.addEventListener('keydown', event => {
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopPropagation(); header.click(); }
  });
  const content = el('div', '', 'inline-drawer-content');
  content.id = 'yt-novel-settings-content';
  content.append(el('small', '主回复完成后保留原版，并用第二 API 生成去 AI 味版。', 'muted'));
  const launch = button('打开小说生产', openPanel, true);
  launch.classList.add('menu_button');
  content.append(launch);
  drawer.append(header, content);
  block.append(drawer);
  parent.append(block);
}
