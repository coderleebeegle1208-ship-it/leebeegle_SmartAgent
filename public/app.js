/* Agent Remote — phone UI (vanilla JS, no build step). Visual direction: B (Linear Mobile reference). */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const state = { token: localStorage.getItem('ar_token') || '', data: null, route: { name: 'home' }, filter: 'all', detail: null, ws: null, meta: null, collapsed: new Set(), draft: {} };
  try { state.collapsed = new Set(JSON.parse(localStorage.getItem('ar_collapsed') || '[]')); } catch {}

  // ---------- helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Minimal markdown for model replies: fenced/inline code, **bold**, and "# heading" lines.
  // Everything else stays plain text so the phone view never shows stray symbols.
  const rich = (text) => {
    const parts = String(text ?? '').split(/(```[\s\S]*?```)/);
    return parts.map((part, i) => {
      if (i % 2) return `<pre class="code">${esc(part.replace(/^```[^\n]*\n?/, '').replace(/```$/, ''))}</pre>`;
      return esc(part)
        .replace(/^#{1,6}\s+(.+)$/gm, '<b class="h">$1</b>')
        .replace(/\*\*([^*\n]+)\*\*/g, '<b class="hot">$1</b>')
        .replace(/`([^`\n]+)`/g, '<code>$1</code>');
    }).join('');
  };
  // Token-usage card formatting (mirrors server/tokens.js so both sides agree on shape).
  const fmtTokens = (n) => (n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`);
  const fmtUsd = (n) => (n == null ? null : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
  const statusLabel = { idle: '대기', working: '작업 중', needs_attention: '승인 필요', done: '완료', error: '오류' };
  const kindLabel = { claude: 'CLAUDE', codex: 'CODEX' };
  const collabStageLabel = { implement: '구현 중', review: '교차 리뷰 중', revise: '최종 수정 중' };
  const phaseLabel = { implement: '구현', review: '리뷰', revise: '수정' };
  // Model names come from the server catalog (server/models.js): each family offers "최신" (an alias
  // that follows the CLI) plus pinned versions. resolved_models records what an alias last ran as.
  const stageCatalog = (stage) => state.data?.models?.[stage] || [];
  const modelLabel = (value) => {
    for (const stage of ['plan', 'exec', 'triage', 'manual']) {
      const hit = stageCatalog(stage).find((o) => o.value === value);
      if (hit) return hit.label;
    }
    if (!value) return '기본 모델';
    const m = String(value).match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
    return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : String(value);
  };
  const resolvedModel = (agent, stage) => {
    try { return (agent?.resolved_models ? JSON.parse(agent.resolved_models) : {})[stage] || null; } catch { return null; }
  };
  // "Fable 최신" alone is ambiguous, so the selected alias also shows what it actually ran as:
  // "Fable 최신 · 5.1". Only the selected option is annotated, and only with its own family's id.
  const optionText = (opt, agent, stage, current) => {
    if (!opt.latest || opt.value !== current) return opt.label;
    const got = resolvedModel(agent, stage);
    if (!got || !String(got).includes(opt.value)) return opt.label;
    const detail = modelLabel(got).replace(`${opt.family} `, '');
    return detail && detail !== opt.label ? `${opt.label} · ${detail}` : opt.label;
  };
  const modelOptions = (stage, current, agent) => stageCatalog(stage)
    .map((o) => `<option value="${o.value}" ${o.value === current ? 'selected' : ''}>${esc(optionText(o, agent, stage, current))}</option>`)
    .join('');
  // Effort ("강도") per pipeline stage, mirroring the desktop "노력" slider: 더 빠르게 ↔ 더 스마트하게.
  const effortLevels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const effortLabel = { low: '낮음', medium: '중간', high: '높음', xhigh: '매우 높음', max: '최대' };
  const EFFORT_STAGES = {
    plan: { field: 'plan_effort', title: '계획', fallback: 'high', hint: '계획은 항상 최소 "높음"으로 실행됩니다.' },
    exec: { field: 'exec_effort', title: '실행', fallback: null, hint: '기본값은 터미널(Claude CLI) 설정을 따릅니다.' },
    manual: { field: 'effort', title: '실행', fallback: null, hint: '단일 모델: 지정한 모델 하나가 이 강도로 실행됩니다.' },
  };
  const stageModelName = (agent, stage) => modelLabel(stage === 'plan' ? agent.plan_model : stage === 'exec' ? agent.exec_model : agent.model);
  // Composer mode chips (권한 · 흐름), mirroring the desktop app's mode menu.
  // [value, 메뉴에 쓰는 이름, 설명, 칩에 쓰는 짧은 이름]
  const PERM_OPTIONS = {
    claude: [
      ['ask', '매번 승인', '도구를 쓰기 전에 폰에서 승인합니다', '매번 승인'],
      ['acceptEdits', '수정 자동 수락', '파일 수정은 자동, 명령 실행은 승인', '수정 자동'],
      ['auto', '자동', 'Claude가 권한 결정을 처리합니다', '권한 자동'],
    ],
    codex: [
      ['ask', '읽기 전용', '프로젝트를 읽고 분석만 합니다', '읽기 전용'],
      ['acceptEdits', '워크스페이스 수정', '등록한 폴더 안의 변경을 허용합니다', '수정 허용'],
    ],
  };
  const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };
  const otherKind = (kind) => (kind === 'codex' ? 'claude' : 'codex');
  const otherProviderName = (kind) => PROVIDER_LABEL[otherKind(kind)];
  const FLOW_OPTIONS = [
    ['auto', '교차 모델', '판단 → 계획 → 실행을 여러 모델이 나눠 맡습니다'],
    ['manual', '단일 모델', '모델 하나를 직접 지정해 실행합니다'],
  ];
  const flowValue = (agent) => agent.pipeline === 'manual' ? 'manual' : 'auto';
  const permValue = (agent) => {
    const opts = PERM_OPTIONS[agent.kind] || PERM_OPTIONS.claude;
    return opts.some(([v]) => v === agent.permission_mode) ? agent.permission_mode : agent.kind === 'codex' ? 'acceptEdits' : 'ask';
  };
  const optionLabel = (opts, value) => (opts.find(([v]) => v === value) || opts[0])[1];
  const chipLabel = (opts, value) => { const o = opts.find(([v]) => v === value) || opts[0]; return o[3] || o[1]; };
  const stageEffort = (agent, stage) => agent?.[EFFORT_STAGES[stage].field] || null;
  // Korean directional particle: 최대로 / 높음으로 (ㄹ-final words also take 로).
  const ro = (word) => {
    const code = word.charCodeAt(word.length - 1) - 0xac00;
    if (code < 0 || code > 11171) return `${word}로`;
    const final = code % 28;
    return final === 0 || final === 8 ? `${word}로` : `${word}으로`;
  };
  const stageEffortText = (agent, stage) => {
    const v = stageEffort(agent, stage);
    if (v) return effortLabel[v];
    const fb = EFFORT_STAGES[stage].fallback;
    return fb ? effortLabel[fb] : '기본';
  };
  const agentStatusText = (agent) => agent?.status === 'needs_attention'
    ? statusLabel.needs_attention
    : agent?.collab_stage ? collabStageLabel[agent.collab_stage] || statusLabel[agent.status] : statusLabel[agent?.status] || agent?.status;
  const ICON = {
    plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    github: '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38l-.01-1.34c-2.23.48-2.7-1.07-2.7-1.07-.36-.93-.89-1.18-.89-1.18-.73-.5.05-.49.05-.49.81.06 1.23.83 1.23.83.72 1.23 1.89.88 2.35.67.07-.52.28-.88.51-1.08-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.6 7.6 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.28.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48l-.01 2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/></svg>',
    pencil: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z"/></svg>',
    term: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7l5 5-5 5M12 17h7"/></svg>',
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4-4"/></svg>',
    globe: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c3 3 3 14 0 17M12 3.5c-3 3-3 14 0 17"/></svg>',
    branch: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8A8F98" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 7.5v9M18 10.5c0 4-12 2-12 6"/></svg>',
    more: '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
    chev: '<svg class="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>',
    trash: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    star: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1.1 5.9L12 16.9l-5.3 2.8 1.1-5.9-4.3-4.1 5.9-.8z"/></svg>',
    edit: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-4-4L4 16z"/></svg>',
  };
  function glyph(status) {
    switch (status) {
      case 'needs_attention': return '<svg class="gl" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#F2994A"/><path d="M9 4.5v5.2" stroke="#fff" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="13" r="1.15" fill="#fff"/></svg>';
      case 'working': return '<svg class="gl" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.5" fill="none" stroke="#D9A521" stroke-width="1.6"/><path d="M9 3.6A5.4 5.4 0 0 1 14.4 9L9 9z" fill="#D9A521"/></svg>';
      case 'done': return '<svg class="gl" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#5E6AD2"/><path d="M5.3 9.2l2.5 2.5 4.9-5" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      case 'error': return '<svg class="gl" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#B42318"/><path d="M6 6l6 6M12 6l-6 6" stroke="#fff" stroke-width="1.9" stroke-linecap="round"/></svg>';
      default: return '<svg class="gl" viewBox="0 0 18 18"><circle cx="9" cy="9" r="7.5" fill="none" stroke="#D5D8DC" stroke-width="1.6"/></svg>';
    }
  }
  const toolIcon = (name) => ({ Read: ICON.file, Write: ICON.pencil, Edit: ICON.pencil, NotebookEdit: ICON.pencil, Bash: ICON.term, Glob: ICON.search, Grep: ICON.search, WebFetch: ICON.globe, WebSearch: ICON.globe }[name] || ICON.term);
  function ago(ts) {
    const d = Math.max(0, Date.now() - ts) / 1000;
    if (d < 60) return '방금';
    if (d < 3600) return `${Math.floor(d / 60)}분 전`;
    if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
    return `${Math.floor(d / 86400)}일 전`;
  }
  const clock = (ts) => new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  const shortPath = (p) => String(p || '').replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, '~').replace(/\/(?:home|Users)\/[^/\s]+/g, '~');
  const tailPath = (p, max = 44) => { const s = shortPath(p); return s.length > max ? '…' + s.slice(-(max - 1)) : s; };
  function toast(msg, ms = 2200) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${state.token}`, ...(opts.headers || {}) },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    if (res.status === 401) {
      openLogin();
      throw new Error('unauthorized');
    }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw new Error(data?.error || res.statusText);
    return data;
  }

  // ---------- login ----------
  function openLogin() {
    const d = $('#dlg-login');
    if (!d.open) d.showModal();
  }
  $('#dlg-login form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = $('#login-token').value.trim();
    const r = await fetch('/api/auth/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) }).then((r) => r.json());
    if (!r.ok) {
      $('#login-error').textContent = '토큰이 올바르지 않습니다.';
      $('#login-error').hidden = false;
      return;
    }
    state.token = token;
    localStorage.setItem('ar_token', token);
    $('#dlg-login').close();
    boot();
  });

  // ---------- websocket ----------
  let wsRetry = 1000;
  function connectWS() {
    if (!state.token) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;
    ws.onopen = () => {
      wsRetry = 1000;
      $('#conn-dot').classList.add('on');
    };
    ws.onclose = () => {
      $('#conn-dot').classList.remove('on');
      setTimeout(connectWS, wsRetry);
      wsRetry = Math.min(wsRetry * 2, 15000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      handleEvent(m);
    };
  }
  function handleEvent(m) {
    if (!state.data) return;
    switch (m.type) {
      case 'agent.updated': {
        const i = state.data.agents.findIndex((a) => a.id === m.agent.id);
        const providerChanged = i >= 0 && state.data.agents[i].kind !== m.agent.kind;
        if (i >= 0) state.data.agents[i] = { ...state.data.agents[i], ...m.agent };
        else state.data.agents.unshift(m.agent);
        recount();
        if (state.route.name === 'agent' && state.detail?.agent.id === m.agent.id) {
          state.detail.agent = { ...state.detail.agent, ...m.agent };
          if (providerChanged) renderAgent(true); else renderAgentHead();
        }
        if (state.route.name === 'home') render();
        break;
      }
      case 'agent.exited': {
        const a = state.data.agents.find((x) => x.id === m.agent_id);
        if (a) a.running = false;
        if (state.route.name === 'agent' && state.detail?.agent.id === m.agent_id) {
          state.detail.agent.running = false;
          renderAgentHead();
        }
        break;
      }
      case 'agent.deleted':
        state.data.agents = state.data.agents.filter((a) => a.id !== m.id);
        recount();
        if (state.route.name === 'agent' && state.detail?.agent.id === m.id) go({ name: 'home' });
        else render();
        break;
      case 'message':
        if (state.route.name === 'agent' && state.detail?.agent.id === m.agent_id) {
          state.detail.messages.push(m.message);
          // Usage cards carry a fresh cumulative rollup too, so refetch instead of a plain append.
          if (m.message.role === 'usage') loadDetail(m.agent_id, true);
          else appendMessage(m.message, true);
        }
        break;
      case 'approval.requested':
      case 'approval.resolved':
        if (state.route.name === 'agent' && state.detail?.agent.id === m.agent.id) loadDetail(m.agent.id, true);
        else if (m.type === 'approval.requested' && state.route.name === 'home') refreshState(true);
        break;
      case 'workspace.created':
      case 'workspace.updated':
      case 'workspace.deleted':
        refreshState(true);
        break;
    }
  }
  function recount() {
    const c = { all: state.data.agents.length, needs_attention: 0, working: 0, done: 0, error: 0, idle: 0 };
    for (const a of state.data.agents) c[a.status] = (c[a.status] || 0) + 1;
    state.data.counts = c;
  }

  // ---------- routing ----------
  function go(route, push = true) {
    state.route = route;
    if (push) history.pushState(route, '', route.name === 'agent' ? `/?agent=${route.id}` : route.name === 'workspace' ? `/?workspace=${route.id}` : '/');
    render();
  }
  // In-app image viewer. Opening pushes a history entry so the phone's back gesture closes the
  // viewer instead of leaving the app; closing via the button pops that same entry.
  function openLightbox(src, caption) {
    let box = $('#lightbox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'lightbox';
      box.className = 'lightbox';
      box.innerHTML = `<div class="lightbox-bar"><span id="lightbox-caption"></span><button type="button" id="lightbox-close" aria-label="닫기">닫기</button></div><div class="lightbox-body"><img id="lightbox-img" alt=""></div>`;
      document.body.appendChild(box);
      $('#lightbox-close').onclick = () => history.back();
    }
    $('#lightbox-img').src = src;
    $('#lightbox-img').alt = caption;
    $('#lightbox-caption').textContent = caption;
    box.hidden = false;
    document.body.classList.add('lightbox-open');
    history.pushState({ ...state.route, lightbox: true }, '', location.href);
  }
  function closeLightbox() {
    const box = $('#lightbox');
    if (box) box.hidden = true;
    document.body.classList.remove('lightbox-open');
  }

  // ---------- composer attachments (photos/videos/links) ----------
  // A "draft" is what's picked but not yet sent, keyed by agent id so it survives navigating
  // away and back (the composer element itself is torn down whenever the agent screen unmounts).
  function draftFor(agentId) {
    return state.draft[agentId] || (state.draft[agentId] = { attachments: [], links: [] });
  }
  function closeAttachMenu() {
    const p = document.querySelector('#attach-popover');
    if (p) p.hidden = true;
    document.querySelector('#attach-btn')?.setAttribute('aria-expanded', 'false');
  }
  function attachThumb(a) {
    if (a.status === 'uploading' || a.status === 'error') return a.previewUrl || '';
    if (a.kind === 'video') return a.poster ? `/api/uploads/${a.poster}?token=${encodeURIComponent(state.token)}` : a.previewUrl || '';
    return `/api/uploads/${a.view || a.file}?token=${encodeURIComponent(state.token)}`;
  }
  function attachStripHTML(agentId) {
    const draft = draftFor(agentId);
    if (!draft.attachments.length && !draft.links.length) return '';
    const cards = draft.attachments.map((a) => `
      <div class="attach-card ${a.status}" data-local="${esc(a.localId)}">
        <img src="${esc(attachThumb(a))}" alt="">
        ${a.kind === 'video' ? '<i class="play">▶</i>' : ''}
        ${a.status === 'uploading' ? `<div class="attach-progress" style="--pct:${a.progress || 0}%"></div>` : ''}
        ${a.status === 'error' ? `<div class="attach-err" title="${esc(a.error || '')}">!</div>` : ''}
        <button type="button" class="x" data-remove="${esc(a.localId)}" aria-label="제거">✕</button>
      </div>`).join('');
    const links = draft.links.map((l) => {
      let host = l; try { host = new URL(l).hostname; } catch {}
      return `<div class="attach-card link" data-local="${esc(l)}"><i>${ICON.globe}</i><span>${esc(host)}</span><button type="button" class="x" data-remove="${esc(l)}" aria-label="제거">✕</button></div>`;
    }).join('');
    return cards + links;
  }
  function renderAttachStrip(agentId) {
    const strip = $('#attach-strip');
    if (!strip) return;
    const html = attachStripHTML(agentId);
    strip.innerHTML = html;
    strip.hidden = !html;
    strip.querySelectorAll('[data-remove]').forEach((b) => (b.onclick = () => {
      const draft = draftFor(agentId);
      const before = draft.attachments.length;
      draft.attachments = draft.attachments.filter((a) => a.localId !== b.dataset.remove);
      if (draft.attachments.length === before) draft.links = draft.links.filter((l) => l !== b.dataset.remove);
      renderAttachStrip(agentId);
    }));
    syncComposerSpace();
  }
  function uploadFile(agentId, file, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/agents/${agentId}/uploads`);
      xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'file'));
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100)); };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('서버 응답을 읽지 못했습니다')); }
        } else {
          let msg = xhr.statusText;
          try { msg = JSON.parse(xhr.responseText)?.error || msg; } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('업로드 실패'));
      xhr.send(file);
    });
  }
  async function uploadEntry(agentId, file, entry) {
    try {
      const descriptor = await uploadFile(agentId, file, (pct) => {
        entry.progress = pct;
        const bar = document.querySelector(`.attach-card[data-local="${CSS.escape(entry.localId)}"] .attach-progress`);
        if (bar) bar.style.setProperty('--pct', pct + '%');
      });
      Object.assign(entry, descriptor, { status: 'done' });
    } catch (e) {
      entry.status = 'error';
      entry.error = e.message;
      toast(`첨부 실패: ${e.message}`);
    }
    renderAttachStrip(agentId);
  }
  function handleFiles(agentId, fileList) {
    const files = [...fileList].filter((f) => /^(image|video)\//.test(f.type));
    if (!files.length) return;
    const draft = draftFor(agentId);
    for (const file of files) {
      const entry = {
        localId: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        status: 'uploading', kind: file.type.startsWith('video') ? 'video' : 'image',
        name: file.name, previewUrl: URL.createObjectURL(file), progress: 0,
      };
      draft.attachments.push(entry);
      uploadEntry(agentId, file, entry);
    }
    renderAttachStrip(agentId);
  }
  // A user message's attachments/links, rendered below its text: photo/video thumbnails plus link chips.
  function messageAttachmentsHTML(meta) {
    const atts = meta.attachments || [], links = meta.links || [];
    if (!atts.length && !links.length) return '';
    const cards = atts.map((a) => {
      if (a.kind === 'video') {
        const src = `/api/uploads/${a.file}?token=${encodeURIComponent(state.token)}`;
        const poster = a.poster ? ` poster="/api/uploads/${a.poster}?token=${encodeURIComponent(state.token)}"` : '';
        return `<video class="att" controls playsinline preload="none"${poster} src="${esc(src)}"></video>`;
      }
      const src = `/api/uploads/${a.view || a.file}?token=${encodeURIComponent(state.token)}`;
      return `<button type="button" class="att image-open" data-src="${esc(src)}" data-caption="${esc(a.name || '')}"><img src="${esc(src)}" alt="${esc(a.name || '')}" loading="lazy"></button>`;
    }).join('');
    const linkChips = links.map((l) => {
      let host = l; try { host = new URL(l).hostname; } catch {}
      return `<a class="link-chip" href="${esc(l)}" target="_blank" rel="noopener">${ICON.globe}${esc(host)}</a>`;
    }).join('');
    return `<div class="attachments">${cards}${linkChips}</div>`;
  }
  window.addEventListener('popstate', (e) => {
    const box = $('#lightbox');
    const wasOpen = !!box && !box.hidden; // the viewer element doesn't exist until first opened
    closeLightbox();
    if (e.state?.lightbox) return; // forward-navigated back onto a viewer entry: nothing to show
    if (wasOpen) return; // only the viewer closed; the agent screen underneath is untouched
    state.route = e.state || { name: 'home' };
    render();
  });
  $('#btn-back').onclick = () => (history.state ? history.back() : go({ name: 'home' }));
  $('#btn-refresh').onclick = () => {
    if (state.route.name === 'agent') return loadDetail(state.route.id, true);
    if (state.route.name === 'workspace') return render();
    refreshState();
    loadUsage(true);
  };

  async function refreshState(silent) {
    try {
      state.data = await api('/state');
      if (state.route.name === 'home') render();
      if (!silent) toast('새로고침');
    } catch (e) {
      if (e.message !== 'unauthorized') toast('연결 실패: ' + e.message);
    }
  }

  // ---------- render ----------
  function render() {
    const isAgent = state.route.name === 'agent';
    document.body.classList.toggle('has-composer', isAgent);
    if (!isAgent) document.body.style.paddingBottom = '';
    $('#btn-back').hidden = state.route.name === 'home';
    $('#topbar').classList.toggle('has-back', state.route.name !== 'home');
    $('#fab').hidden = state.route.name !== 'home';
    if (!isAgent) document.querySelectorAll('.composer').forEach((c) => c.remove());
    if (state.route.name === 'home') renderHome();
    else if (isAgent) renderAgent();
    else if (state.route.name === 'workspace') renderWorkspace();
  }

  function renderHome() {
    $('#topbar-title').textContent = 'leebeegle_SmartAgent';
    const d = state.data;
    if (!d) { view.innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
    const c = d.counts;
    const chips = [['all', '전체'], ['needs_attention', '승인 필요'], ['working', '작업 중'], ['done', '완료'], ['error', '오류']]
      .filter(([k]) => k === 'all' || k === 'needs_attention' || k === 'working' || k === 'done' || (c[k] || 0) > 0)
      .map(([k, l]) => `<button class="chip ${k === 'needs_attention' && c[k] ? 'attn' : ''} ${state.filter === k ? 'on' : ''}" data-filter="${k}">${l} <b>${c[k] || 0}</b></button>`).join('');
    const agentsOf = (wid) => d.agents.filter((a) => a.workspace_id === wid && (state.filter === 'all' || a.status === state.filter));
    const lastActivity = (wid) => Math.max(0, ...d.agents.filter((a) => a.workspace_id === wid).map((a) => a.updated_at));
    const ordered = [...d.workspaces].sort((a, b) => (b.pinned - a.pinned) || (lastActivity(b.id) - lastActivity(a.id)) || (a.id - b.id));
    const hasPinned = ordered.some((w) => w.pinned);
    let lastGroup = null;
    const groups = ordered.map((w) => {
      const list = agentsOf(w.id);
      const allAgents = d.agents.filter((a) => a.workspace_id === w.id);
      const attn = allAgents.filter((a) => a.status === 'needs_attention').length;
      const working = allAgents.filter((a) => a.status === 'working').length;
      const collapsed = state.collapsed.has(w.id) && !attn;
      const groupLabel = hasPinned && (w.pinned ? 'pinned' : 'rest') !== lastGroup ? `<div class="glabel">${w.pinned ? '고정됨' : '최근 활동순'}</div>` : '';
      lastGroup = w.pinned ? 'pinned' : 'rest';
      const rows = list.map((a) => {
        const snippet = a.collab_stage ? `${agentStatusText(a)} · 두 모델이 순서대로 작업하고 있습니다` : a.status === 'error' && a.last_error ? a.last_error : a.pending_approvals ? `승인 ${a.pending_approvals}건 대기 중` : a.last_response || '아직 지시한 작업이 없습니다.';
        return `
        <div class="row ${a.status === 'needs_attention' ? 'attn' : ''} ${a.status === 'error' ? 'error' : ''}" data-agent="${a.id}">
          <div class="g">${glyph(a.status)}</div>
          <div style="min-width:0">
            <div class="t"><span class="kind ${a.kind}">${kindLabel[a.kind] || a.kind}</span><strong>${esc(a.name)}</strong><span class="state ${a.status}">${agentStatusText(a)}</span></div>
            <div class="s">${esc(snippet.replace(/\s+/g, ' '))}</div>
          </div>
          <div class="m">${ago(a.updated_at)}</div>
        </div>`;
      }).join('');
      const summary = collapsed
        ? `에이전트 ${allAgents.length}${working ? ` · 작업 중 ${working}` : ''}${attn ? ` · 승인 ${attn}` : ''}`
        : tailPath(w.path, 30);
      return `${groupLabel}
        <div class="sect ${collapsed ? 'collapsed' : ''}">
          <button class="pin ${w.pinned ? 'on' : ''}" data-pin="${w.id}" aria-label="고정">${ICON.star}</button>
          <button class="n" data-toggle="${w.id}"><strong>${esc(w.name)}</strong></button>
          <button class="tb" data-git="${w.id}">커밋</button>
          <button class="tb" data-add-agent="${w.id}" aria-label="에이전트 추가">${ICON.plus}</button>
          <span class="chev-btn ${collapsed ? '' : 'open'}" data-toggle="${w.id}">${ICON.chev}</span>
          <div class="sect-meta">${repoChipHTML(w)}<small>${esc(summary)}</small></div>
        </div>
        ${collapsed ? '' : rows || `<div class="row-empty">${state.filter === 'all' ? '에이전트를 추가하세요.' : '해당 상태의 에이전트가 없습니다.'}</div>`}`;
    }).join('');
    const comp = d.computer;
    view.innerHTML = `
      <div class="pc">
        <div class="h">${esc(comp.name)} <em class="${comp.connected ? '' : 'off'}">${comp.connected ? 'Connected' : 'Offline'}</em></div>
        <div class="sub">${comp.platform === 'win32' ? 'Windows PC' : comp.platform} · 마지막 동기화 ${ago(state.syncedAt || Date.now())}</div>
        <div class="stat"><span>CPU <b>${comp.cpu}%</b></span><span>RAM <b>${comp.mem}%</b></span></div>
      </div>
      <div class="usage" id="usage">${usageHTML()}</div>
      <div class="rail">${chips}</div>
      ${d.workspaces.length ? groups : '<div class="empty">오른쪽 아래 + 버튼으로 프로젝트 폴더를 추가하세요.</div>'}
      <div style="height:24px"></div>`;
    loadUsage();
    view.querySelectorAll('[data-filter]').forEach((el) => (el.onclick = () => { state.filter = el.dataset.filter; render(); }));
    view.querySelectorAll('[data-agent]').forEach((el) => (el.onclick = () => go({ name: 'agent', id: Number(el.dataset.agent) })));
    view.querySelectorAll('[data-git]').forEach((el) => (el.onclick = () => go({ name: 'workspace', id: Number(el.dataset.git) })));
    view.querySelectorAll('[data-repo]').forEach((el) => (el.onclick = () => openRepoDialog(Number(el.dataset.repo))));
    view.querySelectorAll('[data-add-agent]').forEach((el) => (el.onclick = () => openAddAgent(Number(el.dataset.addAgent))));
    view.querySelectorAll('[data-toggle]').forEach((el) => (el.onclick = () => {
      const id = Number(el.dataset.toggle);
      if (state.collapsed.has(id)) state.collapsed.delete(id); else state.collapsed.add(id);
      try { localStorage.setItem('ar_collapsed', JSON.stringify([...state.collapsed])); } catch {}
      render();
    }));
    view.querySelectorAll('[data-pin]').forEach((el) => (el.onclick = async () => {
      const id = Number(el.dataset.pin);
      const w = d.workspaces.find((x) => x.id === id);
      w.pinned = w.pinned ? 0 : 1;
      render();
      try { await api(`/workspaces/${id}`, { method: 'PATCH', body: { pinned: !!w.pinned } }); } catch (e) { toast(e.message); }
    }));
  }

  // ---------- usage limits ----------
  function usageHTML() {
    const u = state.usage;
    if (!u) return '<div class="urow muted small">사용량 불러오는 중…</div>';
    if (!u.ok && !u.items?.length) return `<div class="urow muted small">사용량을 읽지 못했습니다${u.error ? ` · ${esc(u.error)}` : ''}</div>`;
    return u.items.map((it) => `
      <div class="urow">
        <span class="ul">${esc(it.label)}</span>
        <span class="ubar"><i style="width:${Math.min(100, it.pct)}%" class="${it.pct >= 90 ? 'hot' : it.pct >= 70 ? 'warm' : ''}"></i></span>
        <span class="up ${it.pct >= 90 ? 'hot' : ''}">${it.pct}%</span>
        <span class="ur">${esc(it.resets ? '리셋 ' + it.resets : '')}</span>
      </div>`).join('');
  }
  function usageSlots() {
    const items = state.usage?.items || [];
    return [
      ['5시간 한도', items.find((it) => /5시간|current session/i.test(it.label))],
      ['주간 한도', items.find((it) => /주간.*전체|current week.*all models/i.test(it.label))],
      ['Fable 한도', items.find((it) => /fable/i.test(it.label))],
    ];
  }
  function usagePopupHTML() {
    if (!state.usage) return '<div class="usage-empty">사용량을 불러오는 중…</div>';
    if (!state.usage.ok && !state.usage.items?.length) return `<div class="usage-empty">사용량을 읽지 못했습니다${state.usage.error ? `<small>${esc(state.usage.error)}</small>` : ''}</div>`;
    const limits = usageSlots().map(([label, item]) => `
      <div class="usage-popover-row">
        <div><strong>${label}</strong><small>${item?.resets ? `리셋 ${esc(item.resets)}` : item ? '리셋 시각 정보 없음' : '별도 사용량 항목 없음'}</small></div>
        <b class="${item?.pct >= 90 ? 'hot' : item?.pct >= 70 ? 'warm' : ''}">${item ? `${item.pct}%` : '—'}</b>
      </div>`).join('');
    return limits + agentTokenUsageHTML();
  }
  // Cumulative token usage for the currently open agent (per-run cards are computed in tokens.js
  // on the server; this just reads the two rollups it stores alongside GET /agents/:id).
  function agentTokenUsageHTML() {
    const s = state.detail?.usage_summary;
    if (!s || (!s.today.runs && !s.all.runs)) return '';
    const row = (label, r) => {
      if (!r.runs) return '';
      const cost = fmtUsd(r.cost);
      const saved = r.baseline_cost > 0 && r.cost != null ? Math.round((1 - r.cost / r.baseline_cost) * 100) : null;
      return `<div class="usage-popover-row">
        <div><strong>${label}</strong><small>${r.runs}지시 · 토큰 ${fmtTokens(r.tokens)}</small></div>
        <b>${cost ? cost : '—'}${saved != null && saved > 0 ? ` · ${saved}%↓` : ''}</b>
      </div>`;
    };
    return `<div class="usage-popover-sep">이 대화</div>${row('오늘', s.today)}${row('전체', s.all)}`;
  }
  function primaryUsage() {
    const item = usageSlots()[0]?.[1] || state.usage?.items?.[0];
    return { pct: Math.max(0, Math.min(100, Number(item?.pct) || 0)), label: item?.label || '5시간 한도' };
  }
  function updateComposerUsage() {
    const ring = $('#usage-ring');
    if (ring) {
      const { pct, label } = primaryUsage();
      ring.style.setProperty('--usage-pct', pct);
      ring.classList.toggle('warm', pct >= 70 && pct < 90);
      ring.classList.toggle('hot', pct >= 90);
      ring.setAttribute('aria-label', `${label} ${pct}% 사용 · 자세히 보기`);
      ring.title = `${label} ${pct}% 사용`;
    }
    const body = $('#usage-popover-body');
    if (body) body.innerHTML = usagePopupHTML();
  }
  async function loadUsage(force) {
    if (state.usageLoading) return;
    state.usageLoading = true;
    try {
      state.usage = await api(`/usage${force ? '?refresh=1' : ''}`);
    } catch (e) {
      state.usage = { ok: false, error: e.message, items: [] };
    } finally {
      state.usageLoading = false;
    }
    const host = $('#usage');
    if (host) host.innerHTML = usageHTML();
    updateComposerUsage();
  }

  function composerControlsHTML(agent, locked) {
    const disabled = locked ? 'disabled' : '';
    const reviewer = agent.kind === 'claude' ? 'Codex' : 'Claude';
    let flow;
    if (agent.kind === 'claude' && agent.pipeline !== 'manual') {
      flow = `
        <div class="pipeline-step" title="판단 모델 선택">
          <select id="composer-triage" aria-label="판단 모델" ${disabled}>${modelOptions('triage', agent.triage_model || 'haiku', agent)}</select><span>판단</span>
        </div>
        <i class="pipeline-arrow" aria-hidden="true">→</i>
        <div class="pipeline-step" title="계획 모델 선택">
          <select id="composer-plan" aria-label="계획 모델" ${disabled}>${modelOptions('plan', agent.plan_model || 'fable', agent)}</select>
          <button type="button" class="step-effort" data-stage="plan" aria-haspopup="dialog" aria-expanded="false" title="계획 강도 조절" ${disabled}>계획 · <b>${stageEffortText(agent, 'plan')}</b></button>
        </div>
        <i class="pipeline-arrow" aria-hidden="true">→</i>
        <div class="pipeline-step" title="실행 모델 선택">
          <select id="composer-exec" aria-label="실행 모델" ${disabled}>${modelOptions('exec', agent.exec_model || 'sonnet', agent)}</select>
          <button type="button" class="step-effort" data-stage="exec" aria-haspopup="dialog" aria-expanded="false" title="실행 강도 조절" ${disabled}>실행 · <b>${stageEffortText(agent, 'exec')}</b></button>
        </div>`;
    } else if (agent.kind === 'claude') {
      flow = `
        <div class="pipeline-step" title="실행 모델 선택">
          <select id="composer-model" aria-label="실행 모델" ${disabled}><option value="" ${!agent.model ? 'selected' : ''}>기본 모델</option>${modelOptions('manual', agent.model || '', agent)}</select>
          <button type="button" class="step-effort" data-stage="manual" aria-haspopup="dialog" aria-expanded="false" title="실행 강도 조절" ${disabled}>실행 · <b>${stageEffortText(agent, 'manual')}</b></button>
        </div>
        <span class="pipeline-direct">단일 모델</span>`;
    } else {
      flow = `<span class="pipeline-direct">Codex 직접 실행</span>`;
    }
    void reviewer;
    return `<div class="pipeline-flow" aria-label="자동 실행 흐름">${flow}</div>`;
  }

  const chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  function composerModesHTML(agent, locked) {
    const sessions = agent.provider_sessions || {};
    const perm = chipLabel(PERM_OPTIONS[agent.kind] || PERM_OPTIONS.claude, permValue(agent));
    const chips = [
      `<button type="button" class="mode-chip provider" data-menu="provider" aria-haspopup="menu" aria-expanded="false" title="실행 제공자${agent.auto_failover ? ' · 한도가 차면 자동 전환' : ''}" ${locked ? 'disabled' : ''}>${PROVIDER_LABEL[agent.kind]}${agent.auto_failover ? `<i class="auto" title="한도가 차면 ${otherProviderName(agent.kind)}로 자동 전환">⇄</i>` : sessions[otherKind(agent.kind)] ? '<i class="saved" title="다른 쪽에 저장된 대화 있음"></i>' : ''}${chevron}</button>`,
      `<button type="button" class="mode-chip" data-menu="perm" aria-haspopup="menu" aria-expanded="false" title="권한 방식">${perm}${chevron}</button>`,
    ];
    if (agent.kind === 'claude') {
      chips.push(`<button type="button" class="mode-chip" data-menu="flow" aria-haspopup="menu" aria-expanded="false" title="모델 구성" ${locked ? 'disabled' : ''}>${optionLabel(FLOW_OPTIONS, flowValue(agent))}${chevron}</button>`);
    }
    const reviewer = otherProviderName(agent.kind);
    const reviewDisabled = locked || (!agent.collab_mode && !state.data?.tools?.codex) ? 'disabled' : '';
    return `<div class="mode-chips">${chips.join('')}</div>
      <label class="review-quick" title="${reviewer}가 구현 결과를 읽기 전용으로 검토한 뒤 원래 모델이 최종 수정합니다">
        <span><em class="reviewer-name">${reviewer}</em> 검토</span>
        <input id="collab-mode" type="checkbox" ${agent.collab_mode ? 'checked' : ''} ${reviewDisabled} aria-label="${reviewer} 자동 검토">
      </label>
      <button class="usage-ring" id="usage-ring" type="button" aria-expanded="false"><span aria-hidden="true"></span></button>`;
  }

  // ---------- agent detail ----------
  async function loadDetail(id, keepScroll) {
    try {
      state.detail = await api(`/agents/${id}`);
    } catch (e) {
      toast(e.message);
      return go({ name: 'home' });
    }
    if (state.route.name === 'agent' && state.route.id === id) renderAgent(keepScroll);
  }
  function renderAgent(keepScroll) {
    const id = state.route.id;
    if (!state.detail || state.detail.agent.id !== id) {
      view.innerHTML = '<div class="empty">불러오는 중…</div>';
      loadDetail(id);
      return;
    }
    const { agent, workspace, messages, approvals } = state.detail;
    const providerName = agent.kind === 'codex' ? 'Codex' : 'Claude';
    const reviewerName = agent.kind === 'codex' ? 'Claude' : 'Codex';
    const flowCopy = agent.collab_mode
      ? `${providerName} 구현 → ${reviewerName} 리뷰 → ${providerName} 수정`
      : `${providerName}에서 다음 지시를 이어갑니다`;
    const switchLocked = !!(agent.running || agent.status === 'working' || agent.status === 'needs_attention' || agent.pending_plan);
    $('#topbar-title').textContent = agent.name;
    const y = keepScroll ? window.scrollY : null;
    view.innerHTML = `
      <div class="meta">
        <div class="badges">
          <span class="badge ${agent.status}" id="agent-status">${agentStatusText(agent)}</span>
          <span class="badge-note">권한·모델 구성·강도는 입력창 위에서 바꿉니다</span>
          <span class="spacer"></span>
          <button class="icon-btn" id="agent-menu" aria-label="더 보기">${ICON.more}</button>
        </div>
        <div class="path">${esc(tailPath(workspace.path, 40))}${agent.session_id ? ` · ${esc(agent.session_id.slice(0, 8))}` : ''}</div>
        <div class="provider-bar">
          <div class="provider-copy">
            <span class="eyebrow">${agent.collab_mode ? '협업 흐름' : '현재 실행 모델'}</span>
            <strong id="provider-flow">${flowCopy}</strong>
          </div>
        </div>
      </div>
      <div class="stream" id="msgs"></div>
      <div style="height:16px"></div>`;

    const patchAgent = async (body, msg = '다음 지시부터 적용됩니다') => { const a = await api(`/agents/${agent.id}`, { method: 'PATCH', body }); state.detail.agent = { ...state.detail.agent, ...a }; toast(msg); };
    // Keep the composer (and any half-typed draft) across re-renders of the same agent.
    let composer = document.querySelector('.composer');
    if (composer && composer.dataset.agent !== String(agent.id)) { composer.remove(); composer = null; }
    if (!composer) {
      composer = document.createElement('div');
      composer.className = 'composer';
      composer.dataset.agent = String(agent.id);
      composer.innerHTML = `<div class="usage-popover" id="usage-popover" hidden>
        <div class="usage-popover-head"><strong>Claude 사용 한도</strong><button type="button" id="usage-refresh" aria-label="사용량 새로고침">새로고침</button></div>
        <div id="usage-popover-body"></div>
      </div>
      <div class="effort-popover" id="effort-popover" role="dialog" aria-label="강도 설정" hidden>
        <div class="effort-head"><strong id="effort-title">계획 강도</strong><button type="button" id="effort-reset">기본값으로</button></div>
        <div class="effort-level"><span>노력</span><b id="effort-value">높음</b></div>
        <input type="range" id="effort-range" min="0" max="4" step="1" value="2" aria-label="강도">
        <div class="effort-scale" aria-hidden="true"><span>더 빠르게</span><span>더 스마트하게</span></div>
        <small class="effort-hint" id="effort-hint"></small>
      </div>
      <div class="planbar" id="planbar" hidden><span>계획이 준비되었습니다.</span><button class="btn primary" id="exec-plan">이 계획대로 실행</button></div>
      <div id="approvals"></div>
      <div class="menu-popover" id="mode-popover" role="menu" hidden>
        <div class="menu-head" id="mode-title"></div>
        <div id="mode-items"></div>
      </div>
      <div class="menu-popover" id="attach-popover" role="menu" hidden>
        <div class="menu-head">첨부</div>
        <button type="button" class="menu-item" id="attach-pick"><span><b>사진·동영상 선택</b><small>갤러리에서 고르기</small></span></button>
        <button type="button" class="menu-item" id="attach-camera"><span><b>카메라로 찍기</b><small>바로 촬영</small></span></button>
        <button type="button" class="menu-item" id="attach-link"><span><b>링크 추가</b><small>웹페이지 주소 붙여넣기</small></span></button>
      </div>
      <input type="file" id="attach-input" accept="image/*,video/*" multiple hidden>
      <input type="file" id="attach-camera-input" accept="image/*" capture="environment" hidden>
      <div class="attach-strip" id="attach-strip" hidden></div>
      <div class="composer-modes" id="composer-modes"></div>
      <div class="composer-controls" id="composer-controls"></div>
      <div class="inner">
        <button type="button" class="btn attach-btn" id="attach-btn" aria-label="첨부" aria-haspopup="menu" aria-expanded="false">${ICON.plus}</button>
        <textarea id="prompt" rows="1" placeholder="지시를 입력하세요…"></textarea>
        <button class="btn primary" id="send">보내기</button>
        <button class="btn stop" id="stop" hidden>중지</button>
      </div>`;
      document.body.appendChild(composer);
      $('#exec-plan').onclick = async () => { try { await api(`/agents/${state.detail.agent.id}/execute-plan`, { method: 'POST' }); toast('실행 시작'); } catch (e) { toast(e.message); } };
      const ta = $('#prompt');
      ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 160) + 'px'; });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) sendPrompt(); });
      $('#send').onclick = sendPrompt;
      $('#stop').onclick = async () => { await api(`/agents/${state.detail.agent.id}/stop`, { method: 'POST' }); toast('중지 요청'); };
      $('#usage-refresh').onclick = () => loadUsage(true);
      $('#attach-btn').onclick = () => {
        const p = $('#attach-popover');
        const opening = p.hidden;
        document.querySelectorAll('#usage-popover, #effort-popover, #mode-popover').forEach((el) => { el.hidden = true; });
        document.querySelectorAll('.step-effort[aria-expanded="true"], .mode-chip[aria-expanded="true"], #usage-ring[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
        p.hidden = !opening;
        $('#attach-btn').setAttribute('aria-expanded', String(!opening));
      };
      $('#attach-pick').onclick = () => { closeAttachMenu(); $('#attach-input').click(); };
      $('#attach-camera').onclick = () => { closeAttachMenu(); $('#attach-camera-input').click(); };
      $('#attach-link').onclick = () => {
        closeAttachMenu();
        const url = (prompt('링크 주소를 붙여넣으세요') || '').trim();
        if (!url) return;
        if (!/^https?:\/\//i.test(url)) return toast('http:// 또는 https:// 로 시작하는 주소를 입력하세요');
        draftFor(state.detail.agent.id).links.push(url);
        renderAttachStrip(state.detail.agent.id);
      };
      $('#attach-input').onchange = (e) => { handleFiles(state.detail.agent.id, e.target.files); e.target.value = ''; };
      $('#attach-camera-input').onchange = (e) => { handleFiles(state.detail.agent.id, e.target.files); e.target.value = ''; };
    }
    renderAttachStrip(agent.id);
    $('#composer-controls').innerHTML = composerControlsHTML(agent, switchLocked);
    $('#composer-modes').innerHTML = composerModesHTML(agent, switchLocked);
    updateComposerUsage();
    const triageSel = $('#composer-triage'), planSel = $('#composer-plan'), execSel = $('#composer-exec'), manualSel = $('#composer-model');
    if (manualSel) manualSel.onchange = (e) => patchAgent({ model: e.target.value || null }, `실행 모델을 ${modelLabel(e.target.value)}로 변경했습니다`).then(() => syncEffortUI('manual'));
    if (triageSel) triageSel.onchange = (e) => patchAgent({ triage_model: e.target.value }, `판단 모델을 ${modelLabel(e.target.value)}로 변경했습니다`);
    if (planSel) planSel.onchange = (e) => patchAgent({ plan_model: e.target.value }, `계획 모델을 ${modelLabel(e.target.value)}로 변경했습니다`);
    if (execSel) execSel.onchange = (e) => patchAgent({ exec_model: e.target.value }, `실행 모델을 ${modelLabel(e.target.value)}로 변경했습니다`);
    const usageRing = $('#usage-ring'), usagePopover = $('#usage-popover'), effortPopover = $('#effort-popover'), modePopover = $('#mode-popover');
    const closeEffort = () => {
      if (effortPopover) effortPopover.hidden = true;
      document.querySelectorAll('.step-effort[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    };
    const closeMode = () => {
      if (modePopover) modePopover.hidden = true;
      document.querySelectorAll('.mode-chip[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    };
    const closeUsage = () => { if (usagePopover) { usagePopover.hidden = true; usageRing?.setAttribute('aria-expanded', 'false'); } };
    if (usageRing && usagePopover) usageRing.onclick = () => {
      closeEffort(); closeMode(); closeAttachMenu();
      usagePopover.hidden = !usagePopover.hidden;
      usageRing.setAttribute('aria-expanded', String(!usagePopover.hidden));
      if (!usagePopover.hidden) loadUsage(true);
    };
    // Per-stage effort slider (계획 / 실행). Opens above the composer, saves on release.
    const effortRange = $('#effort-range'), effortValue = $('#effort-value'), effortReset = $('#effort-reset');
    const syncEffortUI = (stage) => {
      const meta = EFFORT_STAGES[stage];
      const current = stageEffort(state.detail.agent, stage);
      const shown = current || meta.fallback || 'high';
      effortRange.value = String(Math.max(0, effortLevels.indexOf(shown)));
      effortValue.textContent = current ? effortLabel[current] : `${effortLabel[shown]} (기본)`;
      $('#effort-title').textContent = `${meta.title} 강도 · ${stageModelName(state.detail.agent, stage)}`;
      $('#effort-hint').textContent = meta.hint;
      effortReset.hidden = !current;
      const chip = document.querySelector(`.step-effort[data-stage="${stage}"] b`);
      if (chip) chip.textContent = stageEffortText(state.detail.agent, stage);
    };
    document.querySelectorAll('.step-effort').forEach((btn) => (btn.onclick = () => {
      const stage = btn.dataset.stage;
      const opening = effortPopover.hidden || effortPopover.dataset.stage !== stage;
      closeEffort(); closeMode(); closeUsage(); closeAttachMenu();
      if (!opening) return;
      effortPopover.dataset.stage = stage;
      syncEffortUI(stage);
      effortPopover.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
    }));
    if (effortRange) {
      effortRange.oninput = () => { effortValue.textContent = effortLabel[effortLevels[Number(effortRange.value)]]; };
      effortRange.onchange = async () => {
        const stage = effortPopover.dataset.stage, level = effortLevels[Number(effortRange.value)];
        try { await patchAgent({ [EFFORT_STAGES[stage].field]: level }, `${EFFORT_STAGES[stage].title} 강도를 ${ro(effortLabel[level])} 변경했습니다`); }
        catch (e) { toast(e.message); }
        syncEffortUI(stage);
      };
      effortReset.onclick = async () => {
        const stage = effortPopover.dataset.stage;
        try { await patchAgent({ [EFFORT_STAGES[stage].field]: null }, `${EFFORT_STAGES[stage].title} 강도를 기본값으로 되돌렸습니다`); }
        catch (e) { toast(e.message); }
        syncEffortUI(stage);
      };
    }
    // Mode menus (권한 · 흐름): a checklist popover like the desktop app's mode picker.
    const openModeMenu = (chip) => {
      const kind = chip.dataset.menu, a = state.detail.agent;
      const sessions = a.provider_sessions || {};
      const providerOptions = [
        ['claude', 'Claude', sessions.claude ? '이어서 쓸 대화가 있습니다' : 'Claude Max 구독으로 실행합니다'],
        ['codex', 'Codex', !state.data?.tools?.codex ? 'Codex를 노트북에서 찾지 못했습니다' : sessions.codex ? '이어서 쓸 대화가 있습니다' : 'ChatGPT 구독으로 실행합니다'],
      ];
      const opts = kind === 'provider' ? providerOptions : kind === 'perm' ? (PERM_OPTIONS[a.kind] || PERM_OPTIONS.claude) : FLOW_OPTIONS;
      const current = kind === 'provider' ? a.kind : kind === 'perm' ? permValue(a) : flowValue(a);
      $('#mode-title').textContent = kind === 'provider' ? '어느 쪽으로 실행할까요' : kind === 'perm' ? `권한 · ${PROVIDER_LABEL[a.kind]}` : '모델 구성';
      $('#mode-items').innerHTML = opts.map(([v, label, desc]) => `
        <button type="button" class="menu-item" role="menuitemradio" data-value="${v}" aria-checked="${v === current}">
          <span><b>${label}</b><small>${desc}</small></span><i aria-hidden="true">✓</i>
        </button>`).join('');
      // The provider menu carries the limit-failover switch, since both are about "who runs this".
      const failoverRow = kind !== 'provider' ? '' : `
        <label class="menu-switch">
          <span><b>한도가 차면 자동 전환</b><small>${PROVIDER_LABEL[a.kind]} 한도에 걸리면 ${otherProviderName(a.kind)}가 이어서 한 번 실행합니다</small></span>
          <input id="auto-failover" type="checkbox" ${a.auto_failover ? 'checked' : ''} ${state.data?.tools?.codex ? '' : 'disabled'}>
        </label>`;
      $('#mode-items').insertAdjacentHTML('beforeend', failoverRow);
      const failover = $('#auto-failover');
      if (failover) failover.onchange = async () => {
        if (failover.checked && !confirm('한도 소진 시 현재 지시가 다른 모델 제공자에게 전달되고, 그 모델이 같은 프로젝트 파일을 확인하게 됩니다. 자동 전환을 켤까요?')) {
          failover.checked = false;
          return;
        }
        try {
          await patchAgent({ auto_failover: failover.checked }, failover.checked ? '한도가 차면 자동 전환합니다' : '자동 전환을 껐습니다');
        } catch (e) {
          failover.checked = !failover.checked;
          toast(e.message);
        }
      };
      modePopover.dataset.menu = kind;
      modePopover.hidden = false;
      chip.setAttribute('aria-expanded', 'true');
      modePopover.querySelectorAll('.menu-item').forEach((item) => (item.onclick = async () => {
        const value = item.dataset.value;
        closeMode();
        if (value === current) return;
        try {
          if (kind === 'provider') {
            await api(`/agents/${agent.id}/switch-provider`, { method: 'POST', body: { kind: value } });
            await loadDetail(agent.id, true);
            toast(`${PROVIDER_LABEL[value]}로 전환했습니다`);
          } else if (kind === 'perm') {
            await patchAgent({ permission_mode: value }, `권한을 "${optionLabel(opts, value)}"로 바꿨습니다`);
            $('#composer-modes').innerHTML = composerModesHTML(state.detail.agent, switchLocked);
            bindModeChips();
          } else {
            await patchAgent(value === 'manual' ? { pipeline: 'manual' } : { pipeline: 'auto', confirm_plan: false }, `모델 구성을 "${optionLabel(opts, value)}"로 바꿨습니다`);
            renderAgent(true);
          }
        } catch (e) { toast(e.message); }
      }));
    };
    const bindModeChips = () => document.querySelectorAll('.mode-chip').forEach((chip) => (chip.onclick = () => {
      const opening = modePopover.hidden || modePopover.dataset.menu !== chip.dataset.menu;
      closeMode(); closeEffort(); closeUsage(); closeAttachMenu();
      if (opening) openModeMenu(chip);
    }));
    bindModeChips();
    if (!state.popoverCloser) {
      state.popoverCloser = true;
      document.addEventListener('pointerdown', (e) => {
        const t = e.target;
        if (!t.closest?.('#effort-popover, .step-effort')) closeEffort();
        if (!t.closest?.('#mode-popover, .mode-chip')) closeMode();
        if (!t.closest?.('#usage-popover, #usage-ring')) closeUsage();
        if (!t.closest?.('#attach-popover, #attach-btn')) closeAttachMenu();
      });
    }
    const collab = $('#collab-mode');
    if (collab) collab.onchange = async () => {
      if (collab.checked && !confirm('교차 협업을 켜면 이 에이전트의 원래 지시, 최근 핵심 대화, 구현 결과와 Git 변경 파일 목록이 Claude와 Codex 양쪽에 전달됩니다. 두 모델은 같은 프로젝트 파일을 순서대로 확인합니다. 교차 협업을 켤까요?')) {
        collab.checked = false;
        return;
      }
      try {
        await patchAgent({ collab_mode: collab.checked }, collab.checked ? '교차 협업을 켰습니다' : '교차 협업을 껐습니다');
        renderAgent(true);
      } catch (e) {
        collab.checked = !collab.checked;
        toast(e.message);
      }
    };
    $('#agent-menu').onclick = () => $('#dlg-agent-menu').showModal();

    let lastDay = '';
    for (const m of messages) {
      const day = new Date(m.created_at).toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });
      if (day !== lastDay) { lastDay = day; $('#msgs').insertAdjacentHTML('beforeend', `<div class="day">${esc(day)}</div>`); }
      appendMessage(m, false);
    }
    renderApprovals(approvals);
    renderAgentHead();
    syncComposerSpace();
    if (!state.usage) loadUsage();
    const sendButton = $('#send');
    if (sendButton) sendButton.textContent = agent.collab_mode ? '협업 실행' : '보내기';
    if (y !== null) window.scrollTo(0, y);
    else window.scrollTo(0, document.body.scrollHeight);
  }
  function renderAgentHead() {
    const a = state.detail?.agent;
    if (!a) return;
    const pill = $('#agent-status');
    if (pill) { pill.className = `badge ${a.status}`; pill.textContent = agentStatusText(a); }
    const flow = $('#provider-flow');
    if (flow) {
      const owner = a.kind === 'codex' ? 'Codex' : 'Claude';
      const reviewer = a.kind === 'codex' ? 'Claude' : 'Codex';
      const activeProvider = a.collab_stage === 'review' ? reviewer : owner;
      flow.textContent = a.collab_stage
        ? `${activeProvider} · ${collabStageLabel[a.collab_stage] || '협업 중'}`
        : a.collab_mode ? `${owner} 구현 → ${reviewer} 리뷰 → ${owner} 수정` : `${owner}에서 다음 지시를 이어갑니다`;
    }
    const pendingPlan = !!a.pending_plan;
    const running = !pendingPlan && (a.running || a.status === 'working' || a.status === 'needs_attention');
    const send = $('#send'), stop = $('#stop'), planbar = $('#planbar');
    if (send) send.hidden = running;
    if (stop) stop.hidden = !running;
    if (planbar) planbar.hidden = !pendingPlan;
  }
  // Tool calls and their results are folded into one "activity" group per burst, like the desktop
  // apps: a one-line summary (실행된 명령 N개, 사용한 도구 M개) that expands to the raw details.
  const APPROVAL_NOTE = /^(승인 요청|승인함|거부함|권한 거부됨)/;
  function openActivity(box) {
    const last = box.lastElementChild;
    return last?.classList.contains('activity') ? last : null;
  }
  function activitySummary(group) {
    const c = group.dataset.commands | 0, t = group.dataset.tools | 0, f = group.dataset.failed | 0;
    const parts = [];
    if (c) parts.push(`실행된 명령 ${c}개`);
    if (t) parts.push(`사용한 도구 ${t}개`);
    if (!parts.length) parts.push('작업 기록');
    return parts.join(', ') + (f ? ` <em>(${f}개 실패)</em>` : '');
  }
  function refreshActivity(group) {
    group.querySelector('.activity-title').innerHTML = activitySummary(group);
    const live = group.querySelector('.activity-live');
    live.textContent = group.dataset.live || '';
    live.hidden = !group.dataset.live;
  }
  function finalizeActivity(box) {
    const group = openActivity(box);
    if (!group) return;
    delete group.dataset.live;
    refreshActivity(group);
  }
  function ensureActivity(box) {
    let group = openActivity(box);
    if (group) return group;
    group = document.createElement('details');
    group.className = 'activity';
    group.innerHTML = `<summary><span class="activity-title"></span><span class="activity-live" hidden></span></summary><div class="activity-body"></div>`;
    box.appendChild(group);
    refreshActivity(group);
    return group;
  }
  function appendMessage(m, scroll) {
    const box = $('#msgs');
    if (!box) return;
    const el = document.createElement('div');
    let meta = {};
    try { meta = m.meta ? JSON.parse(m.meta) : {}; } catch {}
    const folded = m.role === 'tool' || m.role === 'tool_result' || (m.role === 'system' && APPROVAL_NOTE.test(m.content) && openActivity(box));
    if (!folded) finalizeActivity(box);
    if (m.role === 'tool') {
      el.className = 'msg tool';
      const name = meta.tool || '';
      const text = m.content.startsWith(name + ' ') ? m.content.slice(name.length + 1) : m.content;
      el.innerHTML = `<i>${toolIcon(name)}</i><span>${name ? `<b>${esc(name)}</b>` : ''}${esc(shortPath(text))}</span>`;
    } else if (m.role === 'plan') {
      el.className = 'msg plan';
      el.innerHTML = `<div class="plan-h">계획${meta.provider ? ` · ${esc(kindLabel[meta.provider] || meta.provider)}` : ''}</div>${rich(m.content)}`;
    } else if (m.role === 'image') {
      el.className = 'msg image';
      const src = meta.file ? `/api/captures/${meta.file}?token=${encodeURIComponent(state.token)}` : '';
      el.innerHTML = `<button type="button" class="image-open" aria-label="크게 보기"><img src="${src}" alt="${esc(m.content)}" loading="lazy" ${meta.width && meta.height ? `width="${meta.width}" height="${meta.height}"` : ''}></button><figcaption>${esc(m.content)}<span class="time">${clock(m.created_at)}</span></figcaption>`;
      el.querySelector('.image-open').onclick = () => openLightbox(src, m.content);
    } else if (m.role === 'usage') {
      el.className = 'msg usage';
      let u = null;
      try { u = m.meta ? JSON.parse(m.meta) : null; } catch {}
      if (!u) {
        el.textContent = m.content;
      } else {
        const stageLabel = { triage: '판단', plan: '계획', exec: '실행', manual: '실행' };
        const rows = u.stages.map((s) => {
          const label = `${stageLabel[s.stage] || s.stage}${s.phase ? ` · ${phaseLabel[s.phase] || s.phase}` : ''} · ${modelLabel(s.model)}`;
          const cacheNote = s.cacheRead ? ` (캐시 ${fmtTokens(s.cacheRead)})` : '';
          const tok = `입력 ${fmtTokens(s.input)}${cacheNote} · 출력 ${fmtTokens(s.output)}`;
          const cost = fmtUsd(s.cost);
          return `<div class="usage-row"><b>${esc(label)}</b><span>${esc(tok)}</span><i>${cost ? esc(cost) : '—'}</i></div>`;
        }).join('');
        const note = '구독 요금제라 실제 청구는 아니고 API 요금으로 환산한 값입니다.'
          + (u.baseline ? ` 절약률은 모든 단계를 ${esc(modelLabel(u.baseline.model))}로 돌렸을 때와 비교한 추정치입니다.` : '');
        el.innerHTML = `<details class="usage-card"><summary>${esc(m.content)}</summary><div class="usage-rows">${rows}<div class="usage-note">${note}</div></div></details>`;
      }
    } else if (m.role === 'handoff') {
      el.className = 'msg handoff';
      el.textContent = m.content;
    } else if (m.role === 'system') {
      el.className = `msg system ${/^(승인함|거부함|자동|간단|복잡|계획|실행 모델|구독 한도|교차 협업|교차 리뷰|최종 수정|구현)/.test(m.content) ? 'ok' : ''}`;
      el.textContent = shortPath(m.content);
    } else {
      el.className = `msg ${m.role}${meta.is_error ? ' is_error' : ''}`;
      const source = m.role === 'assistant' && meta.provider
        ? `<span class="msg-source">${esc(kindLabel[meta.provider] || meta.provider)}${meta.phase ? ` · ${esc(phaseLabel[meta.phase] || meta.phase)}` : ''}</span>`
        : '';
      el.innerHTML = source + (m.role === 'assistant' ? rich(m.content) : esc(m.content))
        + (m.role === 'user' ? messageAttachmentsHTML(meta) : '')
        + (m.role === 'user' || m.role === 'assistant' ? `<span class="time">${clock(m.created_at)}</span>` : '');
      el.querySelectorAll('.attachments .image-open').forEach((b) => (b.onclick = () => openLightbox(b.dataset.src, b.dataset.caption)));
    }
    if (folded) {
      const group = ensureActivity(box);
      group.querySelector('.activity-body').appendChild(el);
      if (m.role === 'tool') {
        const key = meta.tool === 'Bash' ? 'commands' : 'tools';
        group.dataset[key] = (group.dataset[key] | 0) + 1;
        group.dataset.live = shortPath(m.content).replace(/\s+/g, ' ').slice(0, 90);
      } else if (m.role === 'tool_result' && meta.is_error) {
        group.dataset.failed = (group.dataset.failed | 0) + 1;
      }
      refreshActivity(group);
    } else {
      box.appendChild(el);
    }
    if (scroll) window.scrollTo(0, document.body.scrollHeight);
  }
  // The composer is fixed to the bottom, so the page needs a matching bottom gap; an approval
  // card can double its height, so measure instead of assuming.
  function syncComposerSpace() {
    const composer = document.querySelector('.composer');
    document.body.style.paddingBottom = composer ? `${composer.offsetHeight + 12}px` : '';
  }
  function renderApprovals(list) {
    const host = $('#approvals');
    if (!host) return;
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    host.innerHTML = '';
    for (const ap of list) {
      let input = {};
      try { input = JSON.parse(ap.input_json); } catch {}
      const card = document.createElement('div');
      card.className = 'approve';
      const head = `<div class="k">${glyph('needs_attention').replace('class="gl"', 'class="gl" style="width:16px;height:16px"')}승인 필요 · ${ago(ap.created_at)}</div>`;
      if (ap.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
        card.innerHTML = head + `<h2>질문에 답해주세요</h2>` + input.questions.map((q, qi) => `
          <div class="question" data-q="${qi}"><div class="q">${esc(q.header ? q.header + ' · ' : '')}${esc(q.question)}</div>
            ${(q.options || []).map((o) => `<button type="button" class="opt" data-label="${esc(o.label)}">${esc(o.label)}<small>${esc(o.description || '')}</small></button>`).join('')}
            <input class="reason other" placeholder="직접 입력…">
          </div>`).join('') + `<div class="btns" style="grid-template-columns:1fr"><button class="btn primary" data-answer>답변 보내기</button></div>`;
        const answers = {};
        card.querySelectorAll('.question').forEach((qel, qi) => {
          const q = input.questions[qi];
          qel.querySelectorAll('.opt').forEach((b) => (b.onclick = () => {
            if (q.multiSelect) {
              b.classList.toggle('on');
              answers[q.question] = [...qel.querySelectorAll('.opt.on')].map((x) => x.dataset.label).join(', ');
            } else {
              qel.querySelectorAll('.opt').forEach((x) => x.classList.remove('on'));
              b.classList.add('on');
              answers[q.question] = b.dataset.label;
            }
          }));
          qel.querySelector('.other').oninput = (e) => { if (e.target.value.trim()) answers[q.question] = e.target.value.trim(); };
        });
        card.querySelector('[data-answer]').onclick = () => decide(ap.id, 'allow', { updatedInput: { questions: input.questions, answers } });
      } else {
        let body = '';
        if (ap.tool_name === 'Bash') body = `<div class="cmd"><i>$</i><span>${esc(input.command || '')}</span></div>${input.description ? `<div class="muted small" style="margin-top:6px">${esc(input.description)}</div>` : ''}`;
        else if (ap.tool_name === 'Edit') body = `<div class="cmd"><i>${ICON.pencil}</i><span>${esc(shortPath(input.file_path))}</span></div><div class="diff"><span class="del">- ${esc(String(input.old_string || '').slice(0, 800))}</span><span class="add">+ ${esc(String(input.new_string || '').slice(0, 800))}</span></div>`;
        else if (ap.tool_name === 'Write') body = `<div class="cmd"><i>${ICON.file}</i><span>${esc(shortPath(input.file_path))}</span></div><div class="diff">${esc(String(input.content || '').slice(0, 1500))}</div>`;
        else if (input.file_path) body = `<div class="cmd"><i>${ICON.file}</i><span>${esc(shortPath(input.file_path))}</span></div>`;
        else body = `<div class="diff">${esc(JSON.stringify(input, null, 1).slice(0, 1500))}</div>`;
        card.innerHTML = head + `<h2>${esc(ap.tool_name)} 실행 승인</h2>${body}
          <input class="reason" placeholder="거부 사유 (선택)">
          <div class="btns"><button class="btn ghost" data-deny>거부</button><button class="btn primary" data-allow>허용</button></div>`;
        card.querySelector('[data-allow]').onclick = () => decide(ap.id, 'allow');
        card.querySelector('[data-deny]').onclick = () => decide(ap.id, 'deny', { message: card.querySelector('.reason').value.trim() });
      }
      host.appendChild(card);
    }
    syncComposerSpace();
    if (atBottom) requestAnimationFrame(() => window.scrollTo(0, document.body.scrollHeight));
  }
  async function decide(id, decision, extra = {}) {
    try {
      await api(`/approvals/${id}`, { method: 'POST', body: { decision, ...extra } });
      toast(decision === 'allow' ? '허용했습니다' : '거부했습니다');
    } catch (e) { toast(e.message); }
  }
  async function sendPrompt() {
    const ta = $('#prompt');
    const text = ta.value.trim();
    const agentId = state.detail.agent.id;
    const draft = draftFor(agentId);
    if (draft.attachments.some((a) => a.status === 'uploading')) return toast('업로드가 끝나면 보내세요');
    if (draft.attachments.some((a) => a.status === 'error')) return toast('업로드에 실패한 첨부를 지우거나 다시 시도하세요');
    const attachments = draft.attachments.filter((a) => a.status === 'done').map((a) => ({ id: a.id }));
    const links = draft.links.slice();
    if (!text && !attachments.length && !links.length) return;
    try {
      await api(`/agents/${agentId}/prompt`, { method: 'POST', body: { text, attachments, links } });
      ta.value = '';
      ta.style.height = 'auto';
      delete state.draft[agentId];
      renderAttachStrip(agentId);
    } catch (e) { toast(e.message); }
  }
  $('#dlg-agent-menu').addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    $('#dlg-agent-menu').close();
    const a = state.detail?.agent;
    if (!a) return;
    if (act === 'rename') {
      const name = prompt('새 이름', a.name);
      if (name) await api(`/agents/${a.id}`, { method: 'PATCH', body: { name } });
    } else if (act === 'compact') {
      if (confirm('지금까지의 대화를 짧게 요약해 두고 새 대화로 이어갑니다. 토큰 사용이 크게 줄어듭니다. 진행할까요?')) {
        toast('요약하는 중…');
        try { await api(`/agents/${a.id}/compact`, { method: 'POST' }); toast('대화를 정리했습니다'); loadDetail(a.id, true); }
        catch (e) { toast(e.message); }
      }
    } else if (act === 'reset') {
      if (confirm('세션을 초기화할까요? 이전 대화 맥락이 사라집니다.')) await api(`/agents/${a.id}`, { method: 'PATCH', body: { reset_session: true } });
    } else if (act === 'clear') {
      if (confirm('화면의 대화 기록을 지울까요?')) { await api(`/agents/${a.id}`, { method: 'PATCH', body: { clear_messages: true } }); loadDetail(a.id); }
    } else if (act === 'delete') {
      if (confirm('에이전트를 삭제할까요?')) { await api(`/agents/${a.id}`, { method: 'DELETE' }); go({ name: 'home' }); refreshState(true); }
    }
  });

  // ---------- workspace (git) ----------
  async function renderWorkspace() {
    const id = state.route.id;
    const w = state.data?.workspaces.find((x) => x.id === id);
    $('#topbar-title').textContent = w ? w.name : '워크스페이스';
    view.innerHTML = '<div class="empty">git 정보를 읽는 중…</div>';
    let g;
    try { g = await api(`/workspaces/${id}/git?limit=30`); } catch (e) { view.innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
    const head = `<div class="wshead"><div class="path">${esc(tailPath(w?.path, 48))}</div>${g.isRepo ? `<div class="br">${ICON.branch}브랜치 <b>${esc(g.branch)}</b> · 변경 파일 ${g.changes.length}개</div>` : '<div class="br">git 저장소가 아닙니다.</div>'}</div>`;
    const changes = g.isRepo && g.changes.length ? `<div class="sh">커밋 안 된 변경 <span class="cnt">${g.changes.length}</span></div>` + g.changes.map((c) => `<div class="frow"><span class="st ${esc(c.code || '?')}">${esc(c.code || '?')}</span><span>${esc(c.file)}</span></div>`).join('') : '';
    const commits = g.isRepo ? `<div class="sh">최근 커밋</div>` + (g.commits.map((c) => `<div class="crow" data-hash="${c.hash}"><span class="h">${c.hash}</span><span class="msgline">${esc(c.subject)}</span><span class="when">${ago(c.time)}</span></div>`).join('') || '<div class="row-empty">커밋이 없습니다.</div>') : '';
    view.innerHTML = head + changes + commits + `
      <div class="actions">
        <button class="arow" id="ws-rename">${ICON.edit}이름 변경${ICON.chev}</button>
        <button class="arow danger" id="ws-delete">${ICON.trash}워크스페이스 삭제</button>
      </div>`;
    view.querySelectorAll('[data-hash]').forEach((el) => (el.onclick = async () => {
      const txt = await api(`/workspaces/${id}/git/${el.dataset.hash}`);
      $('#text-title').textContent = el.dataset.hash;
      $('#text-body').textContent = txt;
      $('#dlg-text').showModal();
    }));
    $('#ws-rename').onclick = async () => { const n = prompt('새 이름', w.name); if (n) { await api(`/workspaces/${w.id}`, { method: 'PATCH', body: { name: n } }); toast('저장'); } };
    $('#ws-delete').onclick = async () => { if (confirm('워크스페이스와 소속 에이전트를 삭제할까요? (파일은 지우지 않습니다)')) { await api(`/workspaces/${w.id}`, { method: 'DELETE' }); go({ name: 'home' }); refreshState(true); } };
  }

  // ---------- dialogs ----------
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => b.closest('dialog').close()));
  $('#fab').onclick = openAddWorkspace;
  async function openAddWorkspace() {
    $('#ws-name').value = '';
    $('#ws-path').value = '';
    $('#ws-error').hidden = true;
    $('#dlg-ws').showModal();
    browse();
  }
  async function browse(p) {
    const host = $('#ws-browser');
    try {
      const r = await api(`/browse${p ? `?path=${encodeURIComponent(p)}` : ''}`);
      $('#ws-path').value = r.path;
      const sep = r.path.includes('\\') ? '\\' : '/';
      host.innerHTML = `<div class="cur">${esc(r.path)}</div>` + (r.parent ? `<div data-p="${esc(r.parent)}">↑ 상위 폴더</div>` : '') + r.dirs.map((d) => `<div data-p="${esc(r.path.replace(/[\\/]$/, '') + sep + d)}">${d}</div>`.replace(`>${d}<`, `>${esc(d)}<`)).join('');
      host.querySelectorAll('[data-p]').forEach((el) => (el.onclick = () => browse(el.dataset.p)));
    } catch (e) { host.innerHTML = `<div class="cur">${esc(e.message)}</div>`; }
  }
  $('#form-ws').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/workspaces', { method: 'POST', body: { name: $('#ws-name').value, path: $('#ws-path').value } });
      $('#dlg-ws').close();
      refreshState(true);
    } catch (err) { $('#ws-error').textContent = err.message; $('#ws-error').hidden = false; }
  });
  // ---------- GitHub repository ----------
  function repoChipHTML(w) {
    const r = w.repo;
    if (r?.name) return `<button class="repo-tag" data-repo="${w.id}" title="${esc(r.webUrl || r.url || '')}">${ICON.github}<span>${esc(r.repo)}</span></button>`;
    return `<button class="repo-tag off" data-repo="${w.id}" title="GitHub 저장소 연결">${ICON.github}<span>GitHub 연결</span></button>`;
  }
  let repoWs = null;
  async function openRepoDialog(wid) {
    repoWs = wid;
    const w = state.data?.workspaces?.find((x) => x.id === wid);
    const dlg = $('#dlg-repo');
    $('#repo-title').textContent = `GitHub 저장소 · ${w?.name || ''}`;
    $('#repo-error').hidden = true;
    $('#repo-url').value = '';
    renderRepoCurrent(w?.repo || null);
    dlg.showModal();
    try {
      const fresh = await api(`/workspaces/${wid}/remote`);            // always show the on-disk truth
      if (repoWs === wid) renderRepoCurrent(fresh);
      const ws = state.data?.workspaces?.find((x) => x.id === wid);
      if (ws) ws.repo = fresh;
    } catch {}
  }
  function renderRepoCurrent(r) {
    const has = !!r?.url;
    $('#repo-current').hidden = !has;
    $('#repo-name').innerHTML = `${ICON.github}<span>${esc(r?.name || '')}</span>`;
    $('#repo-url-view').textContent = r?.url || '';
    $('#repo-hint').textContent = r?.isRepo === false
      ? '이 폴더는 아직 Git으로 관리되지 않습니다. 주소를 저장하면 Git 저장소로 만들고 연결합니다.'
      : has ? '폰에서 고친 내용을 이 저장소로 올릴 수 있습니다.' : '';
    // With a repo already connected, changing it is the rare case: keep it folded away.
    const change = $('#repo-change');
    change.open = !has;
    change.classList.toggle('bare', !has);
    $('#repo-submit').textContent = has ? '저장' : '연결';
    $('#repo-submit').hidden = !change.open;   // nothing to submit while the field is folded away
    $('#repo-open').dataset.url = r?.webUrl || '';
    $('#repo-open').hidden = !r?.webUrl;
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');       // clipboard API needs https; fall back
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch {}
      ta.remove();
      return ok;
    }
  }
  $('#repo-change').addEventListener('toggle', () => {
    const open = $('#repo-change').open;
    $('#repo-submit').hidden = !open;
    if (open) $('#repo-url').focus();
  });
  $('#repo-copy').onclick = async () => {
    const url = $('#repo-url-view').textContent.trim();
    toast(url && (await copyText(url)) ? '주소를 복사했습니다' : '복사하지 못했습니다. 주소를 길게 눌러 복사하세요');
  };
  $('#repo-open').onclick = () => {
    const url = $('#repo-open').dataset.url;
    if (url) window.open(url, '_blank', 'noopener');
  };
  $('#form-repo').addEventListener('submit', async (e) => {
    if (e.submitter?.id !== 'repo-submit') return;
    e.preventDefault();
    const url = $('#repo-url').value.trim();
    if (!url) { $('#repo-error').textContent = '주소를 입력하세요.'; $('#repo-error').hidden = false; return; }
    try {
      const info = await api(`/workspaces/${repoWs}/remote`, { method: 'POST', body: { url } });
      const ws = state.data?.workspaces?.find((x) => x.id === repoWs);
      if (ws) ws.repo = info;
      $('#dlg-repo').close();
      toast(`${info.name || '저장소'}에 연결했습니다`);
      render();
    } catch (err) {
      $('#repo-error').textContent = err.message;
      $('#repo-error').hidden = false;
    }
  });

  let addAgentWs = null;
  function openAddAgent(wid) {
    addAgentWs = wid;
    // Fill the dialog's model selects from the same catalog the composer uses.
    document.querySelectorAll('[data-model-stage]').forEach((sel) => {
      const blank = sel.dataset.modelBlank ? `<option value="">${esc(sel.dataset.modelBlank)}</option>` : '';
      sel.innerHTML = blank + modelOptions(sel.dataset.modelStage, sel.value, null);
    });
    $('#agent-name').value = '';
    $('#agent-collab').checked = false;
    $('#agent-collab').disabled = !state.data?.tools?.codex;
    syncAgentKindForm();
    $('#dlg-agent').showModal();
  }
  function syncAgentKindForm() {
    const codex = $('#agent-kind').value === 'codex';
    $('#claude-opts').hidden = codex;
    const perm = $('#agent-perm');
    const previous = perm.value;
    perm.innerHTML = codex
      ? '<option value="ask">읽기 전용</option><option value="acceptEdits">워크스페이스 수정</option>'
      : '<option value="ask">매번 폰에서 승인</option><option value="acceptEdits">파일 수정은 자동, 명령은 승인</option><option value="auto">자동 (분류기 판단)</option>';
    perm.value = codex ? (previous === 'ask' ? 'ask' : 'acceptEdits') : (['ask', 'acceptEdits', 'auto'].includes(previous) ? previous : 'ask');
  }
  $('#agent-kind').onchange = syncAgentKindForm;
  $('#agent-pipeline').onchange = (e) => { const auto = e.target.value === 'auto'; $('#auto-opts').hidden = !auto; $('#manual-opts').hidden = auto; };
  $('#form-agent').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const a = await api('/agents', { method: 'POST', body: {
        workspace_id: addAgentWs, kind: $('#agent-kind').value, name: $('#agent-name').value,
        permission_mode: $('#agent-perm').value, model: $('#agent-model').value || null, effort: $('#agent-effort').value || null,
        pipeline: $('#agent-pipeline').value, plan_model: $('#agent-plan-model').value, exec_model: $('#agent-exec-model').value,
        collab_mode: $('#agent-collab').checked,
      } });
      $('#dlg-agent').close();
      await refreshState(true);
      go({ name: 'agent', id: a.id });
    } catch (err) { toast(err.message); }
  });

  // ---------- settings & push ----------
  $('#btn-settings').onclick = () => {
    $('#set-host').textContent = state.data?.computer.name || location.host;
    $('#set-claude').textContent = state.data?.tools.claude || '';
    $('#set-codex').textContent = state.data?.tools.codex ? '설치됨' : '미설치';
    updatePushStatus();
    $('#dlg-settings').showModal();
  };
  $('#btn-logout').onclick = () => { localStorage.removeItem('ar_token'); location.reload(); };
  $('#btn-push').onclick = enablePush;
  $('#btn-push-test').onclick = async () => { const r = await api('/push/test', { method: 'POST' }); toast(`테스트 발송 (구독 ${r.subscriptions}개)`); };
  async function updatePushStatus() {
    const el = $('#push-status');
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) { el.textContent = '이 브라우저는 푸시를 지원하지 않습니다. (iOS는 홈 화면에 설치 후 가능)'; return; }
    if (location.protocol !== 'https:' && location.hostname !== 'localhost') { el.textContent = '푸시는 HTTPS에서만 동작합니다. Tailscale Serve 등으로 HTTPS 주소를 사용하세요.'; return; }
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    el.textContent = sub ? '이 기기에서 푸시가 켜져 있습니다.' : `알림 권한: ${Notification.permission}`;
  }
  function b64ToU8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  async function enablePush() {
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('알림 권한이 거부되었습니다');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(state.meta.vapidPublicKey) });
      await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
      toast('푸시 알림이 켜졌습니다');
      updatePushStatus();
    } catch (e) { toast('푸시 설정 실패: ' + e.message); }
  }

  // ---------- boot ----------
  async function boot() {
    state.meta = await fetch('/api/meta').then((r) => r.json()).catch(() => ({}));
    if (!state.token) return openLogin();
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
    await refreshState(true);
    state.syncedAt = Date.now();
    connectWS();
    const q = new URLSearchParams(location.search);
    const deepLinkId = q.get('agent') ? { name: 'agent', id: Number(q.get('agent')) }
      : q.get('workspace') ? { name: 'workspace', id: Number(q.get('workspace')) }
      : null;
    if (deepLinkId) {
      // A cold start (push notification tap, PWA relaunch) lands directly on this URL with no
      // history beneath it, so the phone's back gesture has nowhere to go but out of the app.
      // Seed a home entry first so the deep-linked screen sits on top of it.
      history.replaceState({ name: 'home' }, '', '/');
      go(deepLinkId);
    } else render();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { state.syncedAt = Date.now(); if (state.route.name === 'agent') loadDetail(state.route.id, true); else refreshState(true); } });
  }
  boot();
})();
