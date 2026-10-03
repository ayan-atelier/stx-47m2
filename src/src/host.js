export function createHost() {
  const context = () => globalThis.SillyTavern?.getContext?.() || null;
  function on(name, handler) {
    const c = context(), types = c?.eventTypes || c?.event_types, event = types?.[name], source = c?.eventSource;
    if (!event || !source?.on) return () => {};
    source.on(event, handler);
    return () => (source.removeListener || source.off)?.call(source, event, handler);
  }
  async function saveChat() {
    const c = context();
    if (typeof c?.saveChat === 'function') return c.saveChat();
    if (typeof c?.saveMetadata === 'function') return c.saveMetadata();
    throw new Error('当前酒馆没有提供聊天保存接口。');
  }
  async function request(payload, timeoutSeconds) {
    const c = context();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    try {
      const response = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        headers: { ...(c?.getRequestHeaders?.() || { 'Content-Type': 'application/json' }) },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error(`纠偏 API 请求失败（HTTP ${response.status}）。`);
      const text = await response.text();
      if (!text) throw new Error('纠偏 API 没有返回内容。');
      try { return JSON.parse(text); } catch { throw new Error('酒馆接口没有返回有效 JSON。'); }
    } catch (error) {
      if (controller.signal.aborted) throw new Error('纠偏 API 请求超时，原稿已保留。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function currentChat() {
    const c = context();
    if (!c) return null;
    const id = c.chatId ?? c.getCurrentChatId?.();
    const isGroup = c.groupId !== undefined && c.groupId !== null && c.groupId !== '';
    const hasChar = c.characterId !== undefined && c.characterId !== null && c.characterId !== '';
    if ((!isGroup && !hasChar) || !id) return null;
    const char = hasChar ? c.characters?.[c.characterId] : null;
    const group = isGroup ? c.groups?.find(g => String(g.id) === String(c.groupId)) : null;
    return { key: JSON.stringify([isGroup ? String(c.groupId) : char?.avatar || '', id]), id, name: group?.name || char?.name || c.name2 || '当前故事', isGroup, messages: c.chat || [], context: c };
  }
  function toast(message, kind = 'info') { globalThis.toastr?.[kind]?.(String(message), '砚台 · 小说生产'); }
  function refreshChat() {
    const c = context();
    if (typeof c?.reloadCurrentChat === 'function') return c.reloadCurrentChat();
    return null;
  }
  return { context, on, saveChat, request, currentChat, toast, refreshChat };
}
