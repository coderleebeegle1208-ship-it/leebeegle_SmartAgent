# 실제 화면 코드(app.js + style.css)로 홈화면 미리보기 HTML을 만든다. 서버 대신 가짜 응답을 끼워 넣어
# 토큰 없이도 폰 캡처로 볼 수 있게 한다. 결과: design-demos/home-redesign-2026-09/preview-live.html
import io, json, time
src = io.open('public/index.html', encoding='utf-8').read()
now = int(time.time() * 1000)
state = {
  'workspaces': [
    {'id': 1, 'name': 'leebeegle_SmartAgent', 'path': 'C:\\Users\\leebe\\Desktop\\leebeegle_SmartAgent', 'pinned': 1, 'repo': {'name': 'leebeegle_SmartAgent', 'repo': 'lucky-tstore/leebeegle_SmartAgent', 'webUrl': 'https://github.com/lucky-tstore/leebeegle_SmartAgent'}},
    {'id': 2, 'name': 'youtube-factory', 'path': 'C:\\Users\\leebe\\Desktop\\youtube-factory', 'pinned': 0, 'repo': None},
    {'id': 3, 'name': 'shop-landing', 'path': 'C:\\Users\\leebe\\Desktop\\shop-landing', 'pinned': 0, 'repo': {'name': 'shop-landing', 'repo': 'lucky-tstore/shop-landing'}},
  ],
  'agents': [
    {'id': 11, 'workspace_id': 1, 'name': '홈화면 개편', 'kind': 'claude', 'status': 'needs_attention', 'updated_at': now - 20000, 'pending_approvals': 1, 'last_response': ''},
    {'id': 12, 'workspace_id': 1, 'name': '스크롤 버그 수정', 'kind': 'codex', 'status': 'working', 'updated_at': now - 180000, 'queued': 1, 'last_response': 'public/app.js 수정하는 중'},
    {'id': 13, 'workspace_id': 1, 'name': '텔레그램 연동', 'kind': 'claude', 'status': 'done', 'updated_at': now - 7200000, 'last_response': '네, 처리했습니다. 이제 텔레그램으로도 승인할 수 있습니다.'},
    {'id': 21, 'workspace_id': 2, 'name': '쇼츠 영상 생성', 'kind': 'claude', 'status': 'working', 'updated_at': now - 720000, 'jobs': [{'label': 'render-shorts'}], 'last_response': '영상 렌더링 중입니다'},
    {'id': 22, 'workspace_id': 2, 'name': '썸네일 만들기', 'kind': 'codex', 'status': 'error', 'updated_at': now - 3600000, 'last_error': 'ffmpeg를 찾을 수 없습니다'},
    {'id': 31, 'workspace_id': 3, 'name': '랜딩 시안', 'kind': 'claude', 'status': 'done', 'updated_at': now - 86400000, 'last_response': '시안 3개를 보냈습니다.'},
  ],
  'counts': {'all': 6, 'needs_attention': 1, 'working': 2, 'done': 2, 'error': 1},
  'computer': {'name': 'DESKTOP-LEE', 'connected': True, 'platform': 'win32', 'cpu': 23, 'mem': 61},
}
usage = {'ok': True, 'items': [
  {'label': '5시간 한도 (current session)', 'pct': 34, 'resets': '오후 4:00'},
  {'label': '주간 전체 (current week, all models)', 'pct': 72, 'resets': '9월 22일'},
  {'label': 'Fable 주간', 'pct': 18, 'resets': '9월 22일'},
]}
digest = {'totals': {'requests': 9, 'files': 14, 'errors': 1, 'cost': 3.2}, 'agents': [{'id': 11}, {'id': 12}, {'id': 13}, {'id': 21}], 'settings': {'enabled': True, 'time': '18:00'}}
a13 = state['agents'][2]
agent13 = {'agent': {**a13, 'running': False, 'collab_mode': 0, 'blanket_allow': 0}, 'workspace': state['workspaces'][0], 'approvals': [], 'queue': [], 'usage_summary': None,
  'messages': [
    {'id': 1, 'role': 'user', 'content': '텔레그램으로도 승인할 수 있게 해줘', 'created_at': now - 7500000},
    {'id': 2, 'role': 'tool', 'content': 'Read server/index.js', 'created_at': now - 7400000, 'meta': json.dumps({'tool': 'Read', 'input': {'file_path': 'server/index.js'}})},
    {'id': 3, 'role': 'assistant', 'content': '네, 처리했습니다. 이제 텔레그램으로도 승인할 수 있습니다.\n- 승인 요청이 오면 텔레그램에 버튼이 함께 옵니다.\n- **봇 토큰은 설정 창에서 한 번만 넣어 주세요.**', 'created_at': now - 7200000, 'meta': json.dumps({'provider': 'claude'})},
  ]}
stub = """<script>
(() => {
  localStorage.setItem('ar_token', 'preview');
  localStorage.setItem('ar_collapsed', JSON.stringify([3]));
  const STATE = %s, USAGE = %s, DIGEST = %s, AGENT13 = %s;
  // 대화 미리보기: 시작 주소에 ?agent=13 이 있는 것처럼 보이게 한다 (file:// 에서는 주소를 못 바꾸므로)
  if (document.title.includes('대화')) { const O = URLSearchParams; window.URLSearchParams = class extends O { constructor(i) { super(i === location.search ? '?agent=13' : i); } }; }
  history.pushState = () => {}; history.replaceState = () => {};
  const ok = (data) => Promise.resolve(new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } }));
  window.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/state')) return ok(STATE);
    if (u.includes('/api/usage')) return ok(USAGE);
    if (u.includes('/api/digest')) return ok(DIGEST);
    if (u.includes('/api/agents/13')) return ok(AGENT13);
    if (u.includes('/api/skills')) return ok([]);
    return ok({});
  };
  window.WebSocket = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 0); } send() {} close() {} };
  if ('serviceWorker' in navigator) Object.defineProperty(navigator, 'serviceWorker', { value: undefined });
})();
</script>
""" % (json.dumps(state, ensure_ascii=False), json.dumps(usage, ensure_ascii=False), json.dumps(digest, ensure_ascii=False), json.dumps(agent13, ensure_ascii=False))
out = src.replace('href="/style.css"', 'href="../../public/style.css"').replace('src="/app.js"', 'src="../../public/app.js"').replace('src="/icon.svg"', 'src="../../public/icon.svg"')
out = out.replace('<script src="../../public/app.js"></script>', stub + '<script src="../../public/app.js"></script>')
io.open('design-demos/home-redesign-2026-09/preview-live.html', 'w', encoding='utf-8', newline='').write(out)
io.open('design-demos/home-redesign-2026-09/preview-agent.html', 'w', encoding='utf-8', newline='').write(out.replace('<title>leebeegle_SmartAgent</title>', '<title>대화 미리보기</title>'))
print('preview ok')
