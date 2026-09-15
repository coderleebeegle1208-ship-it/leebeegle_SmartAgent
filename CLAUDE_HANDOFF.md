# Claude 작업 인계 — Agent Remote

작성일: 2026-09-15  
상태: 요청한 채팅 입력부 모델 흐름·사용량 표시·리뷰 토글 구현 완료

## 가장 먼저 확인할 것

- 프로젝트 경로: `C:\Users\leebe\Desktop\remote-project`
- 실행: `node --no-warnings=ExperimentalWarning server/index.js`
- 기본 URL: `http://localhost:3000`
- 회귀 테스트: `node --test test/core.test.js`
- 이 폴더는 현재 Git 저장소가 아니므로 `git status`나 커밋 기반 인계는 사용할 수 없다.

## 이번에 완료한 내용

1. Claude 자동 모드는 계속 기본값이다.
2. 채팅 입력창 바로 위에 다음 자동 실행 흐름을 표시한다.

   `Haiku 판단 → Fable 계획 → Sonnet 실행`

3. 각 모델 이름은 실제 `<select>`이며 다음 지시부터 즉시 반영된다.
   - 판단: Haiku, Sonnet, Opus, Fable
   - 계획: Fable, Opus, Sonnet
   - 실행: Sonnet, Opus, Haiku
4. `triage_model`을 agents 테이블에 추가했고 기본값은 `haiku`다. 난이도 분류 호출은 더 이상 Haiku로 하드코딩되지 않는다.
5. 입력창 위에 `Codex 검토` 스위치를 배치했다.
   - OFF: Claude만 실행하며 Codex 리뷰를 건너뛴다.
   - ON: Claude 구현 → Codex 읽기 전용 리뷰 → Claude 최종 수정.
   - Codex 에이전트에서는 대칭적으로 `Claude 검토`라고 표시된다.
   - 협업을 켤 때는 지시·최근 핵심 대화·구현 결과·Git 변경 목록이 다른 제공자에게 전달된다는 확인창을 유지한다.
6. 우측 원형 사용량 표시를 추가했다.
   - 원은 5시간 사용률을 나타낸다.
   - 70%부터 노랑, 90%부터 빨강으로 바뀐다.
   - 누르면 5시간, 주간 전체, Fable 한도와 리셋 시각이 나온다.
   - 팝업에서 사용량을 강제로 새로고침할 수 있다.
7. 상단의 중복 `교차 협업` 스위치는 제거하고 입력창의 리뷰 스위치로 이동했다. `한도 자동 전환` 설정은 기존 위치에 유지했다.

## 추가 완료 (2026-09-15, 단계별 강도)

- PC 버전의 노력(effort) 설정처럼 입력창 위 흐름에서 계획·실행 강도를 단계별로 지정할 수 있다.
  - 각 단계 아래 `계획 · 높음`, `실행 · 기본` 칩을 누르면 `더 빠르게 ↔ 더 스마트하게` 슬라이더 팝오버가 열린다.
  - 낮음/중간/높음/매우 높음/최대. `기본값으로` 버튼으로 되돌린다. 바깥을 누르면 닫힌다.
  - 판단 단계는 단일 분류 호출이라 강도 설정이 없다.
- DB: `agents.plan_effort`, `agents.exec_effort` (TEXT, null 허용). 컬럼 신설 시 기존 `effort` 값을 두 컬럼에 복사한다.
- 서버: `stageEfforts(agent)`가 `{ plan: plan_effort || 'high', exec: exec_effort || null }`을 돌려주고 자동 파이프라인·교차 리뷰(계획 모델 사용)·계획 승인 실행이 이를 쓴다. 수동 파이프라인은 기존 단일 `effort`를 그대로 쓴다.
- 상단 배지의 단일 `강도` select는 수동 모드에서만 보인다. 생성 대화상자의 `강도`는 세 컬럼(effort/plan_effort/exec_effort)에 동일하게 들어간다.
- 실행 로그 문구에 강도가 붙는다. 예: `복잡한 작업 → fable (강도 최대) 계획`.
- 360px 이하에서는 검토 스위치의 "Codex" 접두어를 숨겨 세 단계가 잘리지 않는다.
- 테스트 9/9 통과. 375px·320px 미리보기와 API PATCH로 저장·되돌리기 확인.

## 추가 완료 (2026-09-15, 입력창으로 설정 통합)

- 상단 배지의 권한·실행 방식·수동 모델·강도·계획 확인 select를 모두 제거하고 상태 배지와 `⋯` 메뉴만 남겼다.
- 입력창 위 맨 윗줄 `.composer-modes`(흐름 줄보다 위)에 모드 칩 두 개를 두었다. 누르면 데스크톱 앱의 모드 메뉴처럼 체크 목록 팝오버(`#mode-popover`)가 열린다.
  - 권한 칩: Claude `ask/acceptEdits/auto` = `매번 승인/수정 자동 수락/자동`, Codex `ask/acceptEdits` = `읽기 전용/워크스페이스 수정`. 작업 중에도 바꿀 수 있다(다음 실행부터 반영).
  - 모델 구성 칩: `교차 모델`(pipeline auto, confirm_plan 0으로 초기화) / `단일 모델`(manual). "계획 확인 후"는 권한 `자동`과 헷갈려 칩에서 뺐다. 생성 대화상자의 계획 확인 체크박스도 제거했다(`confirm_plan` 컬럼·서버 로직·`execute-plan` API는 남아 있으나 UI에서 켤 수 없다). 작업 중에는 잠긴다.
- 수동 흐름에서는 첫 줄이 `Sonnet / 실행 · 기본` 한 단계(`#composer-model` + 강도 칩 `data-stage="manual"`, 필드 `effort`)로 바뀐다.
- 서버 변경 없음. 기존 PATCH 필드(`permission_mode`, `pipeline`, `confirm_plan`, `model`, `effort`)를 그대로 쓴다.
- 375px·320px에서 권한/흐름 메뉴 선택, 수동 강도 슬라이더, 칩 갱신 확인. 콘솔 오류 없음.

## 실제 실행 검증 (2026-09-15, 교차 모델 흐름)

임시 워크스페이스 `흐름 테스트`(id 3, scratchpad/flow-test)와 에이전트 `교차 테스트`(id 6, 수정 자동 수락, 계획 강도 중간, 실행 강도 낮음)로 두 번 실행했다.

1. 명확한 유틸 모듈 요청 → Haiku "간단" 판정 → `--model sonnet --effort low` 단일 실행. `node --test` Bash 승인 1회, 테스트 4개 통과.
2. 범위가 모호한 CLI 아키텍처 요청 → Haiku "복잡" 판정 → `--model fable --effort medium --permission-mode plan`으로 계획 → 같은 세션 `--resume`으로 `--model sonnet --effort low` 실행. Bash 승인 1회, 테스트 16개 통과.

서버 spawn 로그에서 단계별 `--effort`가 정확히 붙는 것을 확인했다. 진행 중에는 칩·모델·강도가 잠기고 완료 후 풀린다. 테스트 워크스페이스는 사용자가 확인한 뒤 삭제하면 된다.

## 추가 완료 (2026-09-15, 대화 스트림 접기)

- 연속된 `tool`/`tool_result` 메시지(그 사이의 승인 요청·승인함·거부함 시스템 줄 포함)를 `<details class="activity">` 하나로 묶는다. `appendMessage`의 `ensureActivity`/`finalizeActivity`가 담당한다.
- 요약 줄: `실행된 명령 N개, 사용한 도구 M개 (K개 실패)`. Bash는 명령, 나머지 도구는 도구로 센다. 실패는 `is_error` 결과 수.
- 진행 중(그룹이 마지막 요소일 때)에는 요약 아래에 `▸ 마지막 도구 한 줄`이 실시간으로 바뀌고, 다음 assistant/system 메시지가 오면 사라진다.
- 기본은 접힘. 요약을 누르면 기존 도구/결과 렌더링이 그대로 펼쳐진다. 과거 기록도 같은 규칙으로 접힌다.
- 서버 변경 없음.

## 추가 완료 (2026-09-15, 쉬운 말투 지침)

- `server/style.js`에 폰 화면용 답변 스타일 지침 `PHONE_STYLE_PROMPT`를 두었다. 개발 지식 없는 사람 대상, 짧은 문장, 전문 용어 회피, 마크다운 기호 금지, 결론부터.
- Claude: `buildClaudeArgs`가 항상 `--append-system-prompt`로 붙이고, `runClaude`는 stdin으로 보내는 지시 끝에 `PHONE_STYLE_REMINDER` 한 줄을 덧붙인다(`withPhoneReminder`). 저장·표시되는 사용자 메시지는 그대로다. 이어진 세션은 이전 기술 말투를 따라가므로 시스템 프롬프트만으로는 부족했고, 리마인더까지 붙이자 답이 바뀌었다.
- Codex: 시스템 프롬프트 옵션이 없어 `runCodex`가 지시 앞에 지침 전체를 붙인다(`withPhoneStyle`). `buildCodexArgs` 자체는 그대로라 기존 테스트에 영향 없다.
- 앱: `rich()`가 assistant·plan 본문의 코드블록, `code`, **굵게**, `# 제목`만 HTML로 바꾼다. 나머지는 여전히 escape된 평문이다.
- 2차 수정: "개발을 모르는 대표에게 보고하는 직원" 톤으로 바꾸고 파일·함수 이름·경로 언급을 금지했다. 같은 질문에 "새 기능을 추가하면 도움말에도 자동으로 반영되는 구조입니다."처럼 두 문단으로 답했다. 지침은 약 560토큰(시스템 프롬프트, 세션 내 캐시됨) + 리마인더 약 100토큰/턴이고, 답변이 짧아져 실제 사용량은 오히려 준다.
- 강조: 지침에서 "대표가 꼭 알아야 할 주의·확인 사항 한두 군데만 **이렇게** 감싸라"고 허용했다. 앱 `rich()`가 `**`를 `<b class="hot">`(빨간 글자)로, 백틱 코드는 데스크톱 앱처럼 연한 빨강 배경의 붉은 모노 글자로 렌더링한다. 검증 답변: "Node.js 버전이 16.17 이상이어야 합니다"가 빨간 글자로 표시됨.
- 캐시: 폰에서 굵게만 되고 빨강이 안 나온 원인은 정적 파일 캐시 정책 부재였다. `express.static`에 `Cache-Control: no-cache, must-revalidate`를 붙여 매 로드마다 ETag로 재검증하게 했다. 이미 열어 둔 폰은 한 번 완전히 새로고침(앱 종료 후 재실행)해야 한다.
- 주의: `server/style.js`는 서버 시작 시 읽히므로 문구를 바꾸면 서버를 재시작해야 반영된다.
- 검증: 같은 설명 질문을 지침 적용 전후로 보내 비교. 적용 후 "커맨드를 등록할 때는 한 파일에 목록을 추가하는 것으로 끝납니다"처럼 쉬운 문장으로 답했다. 테스트 10/10.

## 추가 완료 (2026-09-15, 결과 화면 캡처)

- `server/capture.js`: 노트북의 Edge/Chrome을 headless로 띄워 url / 로컬 html 파일 / html 문자열을 PNG로 찍는다. 저장 위치 `data/captures/agent-<id>/<ts>.png`. 의존성 추가 없음. Windows에서는 런처 프로세스가 즉시 종료되고 자식이 파일을 쓰므로 종료 이벤트 대신 파일 생성을 최대 20초 기다린다(이걸 몰라서 처음엔 계속 실패했다).
- `server/mcp-approver.js`: 기존 approver MCP에 `capture` 도구 추가. `POST /internal/capture`를 호출하면 서버가 캡처 후 `role: 'image'` 메시지(meta: file, width, height, source)를 저장·전송한다.
- `server/index.js`: `/internal/capture`, `GET /api/captures/:dir/:name`(정규식으로 경로 고정, `?token=`으로 인증), `/api/state.tools.capture`.
- `server/runners/claude.js`: `--allowedTools mcp__approver__capture`로 승인 없이 바로 실행.
- `server/style.js`: 눈으로 볼 수 있는 결과물이면 마무리 전에 반드시 이 도구로 찍고, 다른 스킬·브라우저 도구는 쓰지 말라고 명시. 처음엔 도구 이름을 안 적어서 에이전트가 사용자 PC에 설치된 `browser-automation` 스킬을 먼저 집었다.
- `public/app.js`/`style.css`: `image` 역할을 카드(이미지 + 캡션 + 시각)로 렌더링. 누르면 앱 안의 전체 화면 뷰어(`#lightbox`, 세로 스크롤)로 연다. 뷰어를 열 때 `history.pushState({...route, lightbox:true})`를 쌓아 폰 뒤로가기가 뷰어만 닫고 에이전트 화면은 그대로 둔다(처음엔 새 탭으로 열어서 PWA에서 이미지가 잘리고 뒤로가기에 앱이 닫혔다). `닫기` 버튼은 `history.back()`.
- 검증: 교차 테스트 에이전트에 소개 페이지를 만들고 보여달라고 지시 → Fable 계획 → Sonnet 구현 → capture 도구 호출 → 폰 대화에 390×2400 캡처가 표시됨. 경로 우회 요청은 404. 테스트 11/11.
- 잘림 원인: headless Chromium은 `--window-size` 너비를 500 미만으로 줘도 레이아웃은 약 492px로 하고 스크린샷만 잘라낸다. `MIN_CAPTURE_WIDTH = 500`으로 하한을 두어 해결(기본 너비도 500). 폰에서는 500px 이미지를 화면 폭에 맞춰 축소해 보여준다.
- Codex 에이전트는 MCP 설정을 넘기지 않아 이 도구가 없다.

## 추가 완료 (2026-09-15, 모델 버전 선택)

- 원인: 설치된 Claude CLI가 2.1.195라 별칭 `fable`이 `claude-fable-5`로 풀렸다(최신 CLI에서는 `claude-fable-5-1`). CLI를 2.1.272로 올려 해결.
- `server/models.js`: 모델 카탈로그 단일 출처. 패밀리별로 별칭(최신) + 고정 버전(Fable 5.1/5, Opus 5/4.8, Sonnet 5/4.6/4.5, Haiku 4.5). 단계별 허용 목록과 `modelLabel()` 제공. `/api/state.models`로 프런트에 내려준다.
- `server/index.js`: 하드코딩된 MODELS/TRIAGE_MODELS/PLAN_MODELS/EXEC_MODELS 제거, `isModelAllowed(stage, value)`로 검증.
- `agents.resolved_models`(JSON): 각 단계가 실제로 어떤 모델 id로 돌았는지 기록. Claude는 init 이벤트의 `model`, 판단 단계는 `runClaudeOnce`의 `modelUsage` 첫 키. `runTurn` opts에 `stage`를 넘겨 구분한다.
- 프런트: 선택한 별칭 옵션만 `Fable 최신 · 5.1`처럼 실제 버전을 덧붙인다(다른 패밀리 별칭에 엉뚱한 버전이 붙던 버그 수정). 에이전트 추가 대화상자의 모델 select도 같은 카탈로그로 채운다.
- 레이아웃: 모델 흐름 줄이 좁아 잘려서 `Codex 검토` 스위치와 사용량 원을 위쪽 모드 칩 줄로 옮겼다. 320px에서도 세 단계가 다 보인다.
- 테스트 12/12.

## 추가 완료 (2026-09-15, 제공자 전환 칩)

- 대화가 길어지면 맨 위까지 스크롤해야 Claude↔Codex를 바꿀 수 있었다. 입력창 위 모드 칩 줄 맨 앞에 제공자 칩을 추가했다(`data-menu="provider"`).
- 메뉴는 기존 mode-popover를 재사용하고 `POST /agents/:id/switch-provider` → `loadDetail`로 갱신한다. 각 항목에 저장된 대화 유무·Codex CLI 미설치 여부를 설명으로 보여준다. 다른 쪽에 세션이 있으면 칩에 점이 붙는다.
- 칩이 늘어나 320px에서 잘리므로 칩들만 `.mode-chips`(가로 스크롤)로 감싸고 검토 스위치·사용량 원은 고정했다.
- 상단 헤더의 Claude/Codex 세그먼트와 `한도 자동 전환`은 그대로 두었다(두 곳 모두 같은 API).
- 작업 중에는 칩이 잠긴다. 375px·320px에서 Claude→Codex→Claude 왕복 확인.
- 실기기(360px)에서 칩 줄이 잘려서 `@media (max-width: 440px)` 한 덩어리로 정리했다. 칩 24px/10px, 모델 select 96px/10px, 검토 스위치 축소 + 제공자 이름 숨김, 사용량 원 26px. 권한 칩은 메뉴와 달리 짧은 이름을 쓴다(`PERM_OPTIONS`의 4번째 항목: 수정 자동 / 권한 자동 / 수정 허용). 320·360·412px 확인.

## 추가 완료 (2026-09-15, 상단 제공자 UI 제거)

- 헤더의 Claude/Codex 세그먼트와 `한도 자동 전환` 줄을 제거했다. 헤더에는 상태·경로·현재 실행 모델 한 줄만 남는다.
- `한도가 차면 자동 전환` 스위치는 제공자 칩 메뉴 하단으로 옮겼다(`.menu-switch`). 확인창과 `auto_failover` PATCH는 그대로. 켜져 있으면 제공자 칩에 `⇄`가 붙는다.
- 쓰지 않게 된 `.provider-seg`, `.flow-settings`, `.flow-toggle`, `.collaboration-toggle` CSS와 `[data-provider]` 핸들러를 삭제했다.
- 390px에서 메뉴 열기·스위치 on/off·칩 표시 확인. (미리보기 브라우저에서는 `confirm()`이 자동 취소되어 JS로 확인창을 통과시켜 검증했다.)

## 추가 완료 (2026-09-15, GitHub 저장소 표시·연결)

- `server/git.js`: `parseRemote`(https/ssh/scp 형식 → owner/repo/webUrl), `gitRemote`, `isValidRemoteUrl`, `setGitRemote`. 저장소가 아니면 `git init` 후 origin을 add/set-url 한다.
- `server/index.js`: `GET|POST /api/workspaces/:id/remote`, `/api/state`의 각 workspace에 `repo` 포함. `git remote`는 경로별 60초 캐시(첫 폴링은 null, 다음 폴링에서 채워짐).
- 보안: URL은 https 또는 git@ 형식만 허용한다(`--upload-pack=...` 같은 인자 주입 차단). 테스트로 고정.
- 프런트: 프로젝트 줄에 GitHub 마크 + 저장소 이름 칩(`[data-repo]`), 없으면 `연결`. 누르면 `#dlg-repo`에서 전체 주소·복사·GitHub 열기·주소 변경. 복사는 `navigator.clipboard` 실패 시 textarea+execCommand로 폴백(폰이 http 접속이면 필요).
- 검증: 실제 워크스페이스에서 이름 표시·복사 동작, git 없던 scratchpad 폴더에 연결 → `git init` + origin 설정 확인. 잘못된 주소는 400.
- 레이아웃: 프로젝트 줄이 한 줄에 다 들어가지 못해 이름이 잘렸다. `.sect`를 2줄 그리드로 바꿨다(1행: 별 + 이름 + 커밋/추가/펼침, 2행: 저장소 태그 + 경로). 저장소는 `.tb`가 아니라 작은 `.repo-tag` 알약으로, 없으면 점선 테두리에 `GitHub 연결`. 320·360·390px 확인.
- 대화상자 정리: 주소를 input이 아니라 `.repo-card` 안의 줄바꿈되는 모노 박스로 보여준다(긴 주소가 잘리지 않는다). 상단에 GitHub 마크 + owner/repo, 아래에 `주소 복사`/`GitHub에서 열기` 버튼 2분할, 그 아래 안내 문구. 주소 변경은 `<details class="repo-change">`로 접어 두고, 접혀 있으면 `저장` 버튼도 숨긴다. 저장소가 없는 프로젝트는 입력칸만 펼친 단순한 형태로 열린다.
- 테스트 13/13.

## 변경한 파일

- `server/db.js`
  - `agents.triage_model TEXT NOT NULL DEFAULT 'haiku'` 마이그레이션 추가.
- `server/index.js`
  - 판단·계획·실행 모델 허용 목록 분리.
  - agent 생성/수정 API에 `triage_model` 추가.
- `server/runners/index.js`
  - 난이도 판단 시 `agent.triage_model` 사용.
  - 실행 로그에 선택한 판단 모델 표시.
- `server/usage.js`
  - 사용량 파서를 `parseUsage`로 export하여 테스트 가능하게 함.
- `public/app.js`
  - 입력창 모델 흐름, 리뷰 스위치, 한도 원/팝업 및 이벤트 연결.
- `public/style.css`
  - 모바일 입력부 레이아웃, 원형 진행 표시, 사용량 팝업 스타일.
- `test/core.test.js`
  - 자동 모드 기본값 및 Fable 사용량 파싱 회귀 테스트.
- `README.md`
  - 새 입력부 사용법 문서화.

## 검증 결과

- `node --check public/app.js server/index.js server/runners/index.js server/usage.js`: 통과
- `node --test test/core.test.js`: 8/8 통과
- 실제 로컬 API:
  - Claude/Codex 실행 파일 감지 정상
  - 기존 에이전트에 `triage_model: haiku` 마이그레이션 정상
  - `/api/usage`에서 5시간·주간 전체·주간 Fable 항목 반환 확인
- 390×844 모바일 미리보기:
  - 모델 흐름과 리뷰 스위치가 입력창 위 한 줄에 정렬됨
  - 사용량 원 클릭 시 세 가지 한도 팝업 표시
  - 판단 모델 선택 변경 및 저장 확인

## 현재 실제 동작에서 알아둘 점

- 사용량 API는 Claude CLI의 `/usage` 결과를 2분 동안 캐시한다. 팝업의 `새로고침`은 `?refresh=1`로 강제 갱신한다.
- Fable 별도 항목이 Claude `/usage` 결과에 없으면 팝업에 `별도 사용량 항목 없음`으로 표시한다.
- 리뷰 스위치는 기존 `collab_mode`를 사용하므로 단순 리뷰 보고서로 끝나는 것이 아니라 원래 구현자가 리뷰를 반영하는 최종 수정 단계까지 수행한다.
- 작업·승인·계획 확인이 진행 중일 때 모델과 리뷰 설정은 잠긴다.
- 협업 중 리뷰어의 한도 오류가 발생하면 구현 결과를 보존하고 오류로 종료한다. 실패 단계부터 재개하는 체크포인트 UI는 아직 구현하지 않았다.

## 다음 작업 후보

우선순위 순서:

1. 협업 단계 실패 시 `이 단계부터 재개` 기능과 체크포인트 저장.
2. Fable 계획 한도 시 `Sonnet 계획 → Sonnet 실행` 내부 대체 후, Claude 전체 한도일 때만 Codex로 전환.
3. Codex 실행 파일 존재 여부뿐 아니라 `codex login status`를 확인해 `로그인됨/로그인 필요` 표시.
4. 모바일 실기기에서 320px·430px 폭 및 다크 모드 추가 검증.

Claude는 위 상태를 기준으로 이미 완료된 파일을 되돌리지 말고, 다음 작업 후보 중 사용자가 요청한 항목부터 이어서 구현하면 된다.
