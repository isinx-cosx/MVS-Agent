/**
 * 开发用的内置客户端页面。
 *
 * ⚠️ **这不是产品 UI。** 它是一张用来验证边界的体检表：能连上就说传输通了，
 * 能收到事件就说事件流通了，能点「允许」就说审批通道通了。
 * 真正的客户端是独立构建的产物（Vite + 框架随你），走同一份协议。
 *
 * 刻意写成零依赖的单文件，免得为了看一眼效果先装一堆东西。
 * 也刻意不用模板字符串语法糖，避免和宿主的字符串包装打架。
 */

export function devClientHtml(wsPath = '/ws'): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MVS Agent · 开发页</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; font:14px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
         background:#111; color:#ddd; display:flex; flex-direction:column; height:100vh; }
  header { padding:10px 14px; border-bottom:1px solid #2a2a2a; display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .pill { padding:2px 8px; border-radius:10px; background:#222; font-size:12px; }
  .allow { color:#6ee7a8 } .deny { color:#f87171 } .ask { color:#fbbf24 }
  main { flex:1; overflow:auto; padding:14px; }
  .msg { margin-bottom:10px; padding:8px 10px; border-left:2px solid #333; white-space:pre-wrap; }
  .msg.user { border-color:#60a5fa } .msg.assistant { border-color:#a78bfa }
  .msg.tool { border-color:#34d399; color:#9ca3af } .msg.system { border-color:#444; color:#888 }
  .role { font-size:11px; color:#777; display:block; margin-bottom:2px }
  aside { border-top:1px solid #2a2a2a; max-height:34vh; overflow:auto; padding:8px 14px; font-size:12px; color:#9ca3af }
  aside div { white-space:pre-wrap }
  footer { border-top:1px solid #2a2a2a; padding:10px 14px; display:flex; gap:8px; }
  input { flex:1; background:#1a1a1a; color:#eee; border:1px solid #333; border-radius:6px; padding:8px 10px; font:inherit }
  button { background:#2563eb; color:#fff; border:0; border-radius:6px; padding:8px 14px; font:inherit; cursor:pointer }
  button.ghost { background:#333 } button:disabled { opacity:.4; cursor:default }
  #approval { display:none; gap:8px; align-items:center; padding:10px 14px; background:#3b2f0a; border-top:1px solid #6b5a12 }
  #approval.show { display:flex }
</style>
</head>
<body>
<header>
  <strong>MVS Agent</strong>
  <span class="pill" id="status">连接中…</span>
  <span class="pill" id="meta"></span>
</header>
<main id="messages"></main>
<aside id="events"></aside>
<div id="approval">
  <span id="approvalText"></span>
  <button id="allowBtn">允许</button>
  <button id="denyBtn" class="ghost">拒绝</button>
</div>
<footer>
  <input id="input" placeholder="输入消息，回车发送" autocomplete="off">
  <button id="sendBtn">发送</button>
  <button id="abortBtn" class="ghost">中断</button>
</footer>
<script>
(function () {
  var params = new URLSearchParams(location.search);
  var token = params.get('token') || '';
  var statusEl = document.getElementById('status');
  var metaEl = document.getElementById('meta');
  var messagesEl = document.getElementById('messages');
  var eventsEl = document.getElementById('events');
  var approvalEl = document.getElementById('approval');
  var approvalText = document.getElementById('approvalText');
  var inputEl = document.getElementById('input');
  var pendingApproval = null;
  var streamed = '';

  function api(path, body) {
    return fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).then(function (r) { return r.json(); });
  }

  function renderMessages(messages) {
    messagesEl.textContent = '';
    messages.forEach(function (m) {
      var div = document.createElement('div');
      div.className = 'msg ' + m.role;
      var role = document.createElement('span');
      role.className = 'role';
      role.textContent = m.role + (m.toolCallId ? ' (' + m.toolCallId + ')' : '');
      div.appendChild(role);
      div.appendChild(document.createTextNode(m.content || ''));
      if (m.toolCalls && m.toolCalls.length) {
        var calls = document.createElement('div');
        calls.className = 'role';
        calls.textContent = '→ 调用工具: ' + m.toolCalls.map(function (c) { return c.name; }).join(', ');
        div.appendChild(calls);
      }
      messagesEl.appendChild(div);
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function logEvent(line) {
    var div = document.createElement('div');
    div.textContent = line;
    eventsEl.appendChild(div);
    eventsEl.scrollTop = eventsEl.scrollHeight;
  }

  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = 'pill ' + (cls || '');
  }

  function applyProjection(p) {
    setStatus(p.status, p.status === 'awaiting-approval' ? 'ask' : '');
    metaEl.textContent = '模式 ' + p.mode + ' · 轮次 ' + p.turn + ' · 步数 ' + p.step + ' · ' + p.workspace;
    renderMessages(p.messages);
    pendingApproval = p.pendingApproval;
    approvalEl.className = pendingApproval ? 'show' : '';
    approvalText.textContent = pendingApproval ? ('需要确认: ' + pendingApproval.tool + ' ' + pendingApproval.argsJson) : '';
  }

  var ws = new WebSocket('ws://' + location.host + '${wsPath}?token=' + encodeURIComponent(token));

  ws.onopen = function () { logEvent('· 已连接'); };
  ws.onclose = function () { setStatus('已断开', 'deny'); logEvent('· 连接关闭'); };
  ws.onerror = function () { logEvent('· 连接错误'); };

  ws.onmessage = function (ev) {
    var frame = JSON.parse(ev.data);
    if (frame.kind === 'projection') { applyProjection(frame.projection); return; }
    var e = frame.envelope.event;
    switch (e.type) {
      case 'model_text_delta':
        streamed += e.text;
        logEvent('· 文本 +' + e.text.length + ' 字');
        break;
      case 'assistant_message':
        streamed = '';
        logEvent('· 助手消息 (' + e.toolCalls.length + ' 个工具调用)');
        break;
      case 'policy_decision':
        logEvent('· 策略 ' + e.tool + ' → ' + e.decision + ' [' + e.reason + ']');
        break;
      case 'tool_intent':
        logEvent('· 意图 ' + e.tool + ' ' + e.argsJson);
        break;
      case 'tool_settled':
        logEvent('· 结算 ' + e.tool + ' ok=' + e.ok + (e.recoveryTxnId ? ' 可撤销' : ''));
        break;
      case 'approval_requested':
        pendingApproval = { approvalId: e.approvalId, tool: e.tool, argsJson: e.argsJson };
        setStatus('等待确认', 'ask');
        approvalEl.className = 'show';
        approvalText.textContent = '需要确认: ' + e.tool + ' ' + e.argsJson;
        logEvent('· 请求确认 ' + e.tool);
        break;
      case 'approval_resolved':
        pendingApproval = null;
        approvalEl.className = '';
        logEvent('· 确认结果 ' + (e.granted ? '允许' : '拒绝'));
        break;
      case 'turn_finished':
        setStatus(e.status, e.status === 'error' ? 'deny' : '');
        logEvent('· 一轮结束 (' + e.status + ')');
        api('/projection').then(function (r) { if (r.projection) applyProjection(r.projection); });
        break;
      case 'notice':
        logEvent('· 通知 [' + e.code + '] ' + e.message);
        break;
      case 'error':
        logEvent('× 错误 ' + e.message);
        setStatus('错误', 'deny');
        break;
      default:
        logEvent('· ' + e.type);
    }
  };

  function send() {
    var text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    logEvent('▸ 发送: ' + text);
    api('/command', { type: 'user_message', text: text });
  }

  document.getElementById('sendBtn').onclick = send;
  inputEl.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') send(); });
  document.getElementById('abortBtn').onclick = function () { api('/command', { type: 'abort' }); };

  function answer(granted) {
    if (!pendingApproval) return;
    api('/command', { type: 'approve', approvalId: pendingApproval.approvalId, granted: granted });
  }
  document.getElementById('allowBtn').onclick = function () { answer(true); };
  document.getElementById('denyBtn').onclick = function () { answer(false); };
})();
</script>
</body>
</html>
`
}
