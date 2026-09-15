# leebeegle_SmartAgent (구 Agent Remote)

윈도우 PC에서 돌아가는 Claude Code / Codex를 **스마트폰 웹앱**으로 지시하고, 승인하고, 완료 알림을 받는 개인용 대시보드.

- API 키 불필요. 이미 로그인된 `claude` (claude.ai 계정) / `codex` (ChatGPT 계정) CLI를 그대로 실행합니다.
- 서버는 Node.js 하나. 외부 의존성은 express, ws, web-push 뿐.
- 외부 접속은 Tailscale, 알림은 Web Push(안드로이드 Chrome / iOS 홈화면 설치 PWA).

## 0. 선행 조건: CLI 로그인

이 앱은 `claude` CLI를 백그라운드로 실행하므로 **CLI 자체가 로그인되어 있어야** 합니다.
데스크톱 앱만 쓰던 경우 CLI에는 로그인이 안 되어 있을 수 있습니다. 터미널에서 한 번만:

```powershell
claude
```

실행 후 `/login` 으로 claude.ai 계정 로그인 → 종료. 확인:

```powershell
claude -p "pong 이라고만 답해"
```

"Not logged in" 이 나오면 아직 로그인 전입니다. Codex도 마찬가지로 `codex login` 을 한 번 해두면 됩니다.

## 1. 실행

```powershell
npm install
node scripts/make-icons.js   # 최초 1회, PWA 아이콘 생성
npm start
```

대화형 터미널에는 `Access token: ...` 이 출력됩니다. 폰에서 처음 접속할 때 이 토큰을 입력합니다.
설정은 `data/config.json` 에 저장됩니다 (토큰, VAPID 키, 포트). 숨김 자동 시작 로그에는 토큰 값이 기록되지 않습니다.

같은 와이파이에서 먼저 확인: `http://<PC-IP>:3000`

## 2. 외부 접속 (Tailscale)

1. PC와 폰에 Tailscale 설치, 같은 계정으로 로그인.
2. PC에서 HTTPS 주소 만들기 (푸시 알림은 HTTPS 필수):

```powershell
tailscale serve --bg 3000
```

3. 출력된 `https://<pc-name>.<tailnet>.ts.net` 을 폰에서 열고 **홈 화면에 추가**.
4. 앱 설정(⚙) → **푸시 알림 켜기** → 테스트.

## 3. 사용

- ＋ : 프로젝트 폴더를 워크스페이스로 등록
- 워크스페이스의 **＋ 에이전트** : Claude / Codex 에이전트 생성 (권한 방식 선택)
- 에이전트 화면에서 지시 입력 → 실시간 로그 → 완료 시 푸시
- 입력창 왼쪽 **＋** 버튼으로 사진·동영상을 첨부하거나 카메라로 바로 찍고, 링크를 추가할 수 있습니다. 사진은 모델이 직접 보고, 동영상은 장면 사진 몇 장으로(ffmpeg 설치 시), 링크는 승인 없이 바로 읽고 답합니다. 첨부 파일은 `data/uploads/`에 저장됩니다.
- 같은 에이전트에서 **Claude / Codex**를 바로 전환. 제공자별 세션을 따로 보관해 다시 돌아와도 이전 대화를 이어갑니다.
- 선택 사항인 **한도 자동 전환**을 켜면 구독 한도 오류를 감지해 현재 지시를 다른 제공자가 이어서 처리합니다. 처음 켤 때 프로젝트 파일과 지시가 다른 제공자에게 전달된다는 확인을 받습니다.
- **교차 협업**을 켜면 현재 선택한 제공자가 구현하고, 반대 제공자가 읽기 전용으로 리뷰한 뒤, 최초 구현자가 리뷰를 검증하고 최종 수정합니다. Claude와 Codex 어느 쪽에서 시작해도 같은 방식으로 동작합니다.
- 승인 요청이 오면 카드에서 **허용/거부** (Claude가 AskUserQuestion 을 쓰면 선택지 UI)
- **커밋** 버튼: 브랜치, 커밋 안 된 변경, 최근 커밋과 상세

권한 모드
- Claude `매번 승인`: 파일 수정·명령 실행마다 폰으로 승인 요청
- Claude `수정 자동`: 파일 수정은 자동, 그 외 명령은 승인 요청
- Claude `자동`: Claude Code auto 모드(분류기)
- Codex `읽기 전용`: 프로젝트를 읽고 분석만 허용
- Codex `워크스페이스 수정`: 등록한 프로젝트 폴더 안의 변경을 허용

실행 방식 (Claude 에이전트, 한도 절약)
- `자동` (기본): 지시가 오면 판단 모델(Haiku 기본)이 간단/복잡을 판정 → 간단하면 실행 모델(Sonnet 기본)이 바로 처리, 복잡하면 계획 모델(Fable 기본)이 계획 모드로 계획만 세우고 실행 모델이 같은 세션에서 구현.
- 채팅 입력창 바로 위의 `Haiku 판단 → Fable 계획 → Sonnet 실행`에서 각 모델 이름을 눌러 다음 지시부터 사용할 모델을 바꿀 수 있습니다. 판단은 Haiku/Sonnet/Opus/Fable, 계획은 Fable/Opus/Sonnet, 실행은 Sonnet/Opus/Haiku를 지원합니다.
- 각 모델은 `Fable 최신`처럼 최신을 따라가는 항목과 `Fable 5.1`, `Fable 5`처럼 버전을 고정하는 항목을 함께 제공합니다. 최신을 고르면 실제로 어떤 버전이 쓰였는지 `Fable 최신 · 5.1`처럼 옆에 표시됩니다(한 번 실행한 뒤부터). 선택 가능한 버전 목록은 `server/models.js`에 있습니다.
- 최신 별칭이 가리키는 버전은 설치된 Claude CLI 버전에 따라 달라집니다. CLI가 오래되면 구버전에 묶이므로 `npm i -g @anthropic-ai/claude-code@latest`로 올려 두세요.
- 각 단계 아래의 `계획 · 높음`, `실행 · 기본`을 누르면 PC 버전의 노력 설정처럼 `더 빠르게 ↔ 더 스마트하게` 슬라이더가 열립니다. 낮음/중간/높음/매우 높음/최대 중에서 단계별로 강도를 정하고, `기본값으로`를 누르면 되돌립니다. 계획은 항상 최소 "높음"으로 실행되고 실행 강도의 기본값은 터미널(Claude CLI) 설정을 따릅니다. 판단은 한 번의 분류 호출이라 강도 설정이 없습니다.
- 입력창 위 첫 줄 맨 왼쪽 칩이 현재 실행 제공자(Claude/Codex)입니다. 눌러서 바로 바꿀 수 있고, 다른 쪽에 이어서 쓸 대화가 있으면 점으로 표시됩니다.
- 같은 메뉴 아래쪽의 `한도가 차면 자동 전환`을 켜면, 지금 쓰는 쪽이 구독 한도에 걸렸을 때 다른 쪽이 그 지시를 한 번 이어서 실행합니다. 켜져 있으면 칩에 ⇄ 표시가 붙습니다.
- 같은 줄의 `Codex 검토`를 켜면 Claude 구현 → Codex 읽기 전용 리뷰 → Claude 최종 수정 흐름을 실행하고, 끄면 Codex 리뷰 없이 Claude만 실행합니다. Codex에서 시작한 에이전트에는 `Claude 검토`로 표시됩니다.
- 결과물이 웹페이지·HTML·화면처럼 눈으로 볼 수 있는 것이면 Claude가 노트북의 Edge/Chrome으로 캡처해 폰 대화에 이미지로 올립니다. "어떻게 생겼는지 보여줘"라고 하면 됩니다. 이미지는 `data/captures/`에 저장되고 눌러서 크게 볼 수 있습니다. (Codex 에이전트는 이 도구가 없습니다.)
- 홈 화면의 프로젝트 줄에 GitHub 저장소 이름이 표시됩니다. 누르면 전체 주소가 나오고 `주소 복사`로 복사하거나 `GitHub에서 열기`로 브라우저에서 열 수 있습니다.
- 저장소가 없는 프로젝트는 같은 자리에 `연결`이 보입니다. 저장소 주소를 붙여넣으면 연결되고, Git으로 관리되지 않던 폴더는 이때 `git init`까지 함께 처리합니다.
- 대화가 길어지면(한 번 실행에 읽는 양이 30만 토큰을 넘으면) 앱이 값싼 모델로 지금까지의 대화를 요약해 두고 새 대화로 이어갑니다. 요약은 대화창에 `대화 정리 · 이어가기 메모`로 남고, 다음 지시에 자동으로 붙습니다. 기준은 `data/config.json`의 `compactAfterTokens`(0이면 끔)이고, 에이전트 메뉴의 `대화 정리`로 언제든 직접 할 수 있습니다.
- 승인 요청(파일 수정·명령 실행·질문)은 입력창 바로 위에 나타납니다. 대화가 길어도 스크롤을 올릴 필요가 없습니다.
- 우측 원형 사용량 버튼은 5시간 한도의 사용 비율을 나타냅니다. 누르면 5시간 한도, 주간 전체 한도, Fable 한도와 리셋 시각을 확인하고 새로고침할 수 있습니다.
- `수동`: 모델 하나를 직접 지정. 입력창 위 흐름이 `Sonnet / 실행 · 기본` 한 단계로 바뀌고, 모델 이름과 강도 칩을 같은 방식으로 바꿉니다.
- 입력창 위 맨 윗줄의 칩으로 권한과 모델 구성을 고릅니다. 클로드 데스크톱의 모드 메뉴처럼 눌러서 체크 목록에서 선택합니다.
  - 권한: `매번 승인` / `수정 자동 수락` / `자동` (Codex 에이전트는 `읽기 전용` / `워크스페이스 수정`)
  - 모델 구성: `교차 모델`(판단 → 계획 → 실행을 여러 모델이 분담) / `단일 모델`(모델 하나를 직접 지정). 교차 모델을 고르면 계획 확인 없이 바로 실행합니다.
  - 상단 배지에는 상태만 남고, 권한·흐름·모델·강도는 모두 입력창 위에서 관리합니다.
- 서브에이전트(탐색 등)는 기본으로 Haiku를 씁니다 (`data/config.json`의 `subagentModel`, 비우면 해제).

교차 협업 흐름

```text
Claude 시작: Claude 구현 → Codex 읽기 전용 리뷰 → Claude 최종 수정
Codex 시작:  Codex 구현  → Claude 읽기 전용 리뷰 → Codex 최종 수정
```

- 에이전트 화면에서 `교차 협업`을 한 번 켜면 이후 지시마다 위 흐름을 자동 실행합니다.
- 리뷰어에게는 원래 지시, 최근 핵심 대화, 구현 결과와 Git 변경 파일 목록만 제한적으로 전달됩니다. 소스 상세는 두 CLI가 공유하는 워크스페이스에서 직접 확인합니다.
- 메시지에는 `CLAUDE · 구현`, `CODEX · 리뷰`, `CLAUDE · 수정`처럼 단계가 표시됩니다.
- 협업 실행은 중간 계획 확인에서 멈추지 않고 세 단계를 연속 처리합니다. 파일·명령 승인이 필요한 구현 단계는 기존 승인 설정을 그대로 따릅니다.
- 리뷰어는 파일을 수정하지 못하도록 Claude 도구와 Codex sandbox를 읽기 전용으로 제한합니다.
- 한도 자동 전환이 함께 켜져 있으면 구현 또는 최종 수정 단계가 한도에 막힐 때 반대 제공자가 한 번 이어받습니다. 리뷰어 한도 소진 시에는 구현 결과를 보존하고 오류로 종료합니다.

회귀 테스트:

```powershell
npm test
```

## 4. 항상 켜두기

- 로그인 시 자동 시작 (숨김 창, 로그는 `data/server.log`):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\register-autostart.ps1
```

  등록되는 작업 이름은 `leebeegle_SmartAgent`이고, Claude나 터미널과 무관하게 로그인만 하면 서버가 뜹니다. 서버가 죽으면 1분 간격으로 3번까지 자동 재시작합니다.
  해제: `powershell -ExecutionPolicy Bypass -File scripts\unregister-autostart.ps1`
  폴더 이름이나 위치를 바꾸면 등록 명령을 한 번 더 실행해야 새 경로를 가리킵니다.
- 서버 재시작: `powershell -ExecutionPolicy Bypass -File scripts\restart-server.ps1`. 폰에서 에이전트에게 "서버 재시작해줘"라고 하면 에이전트가 전용 도구(`restart_server`)로 예약하고, 진행 중인 답변이 끝난 뒤 5초 안에 다시 켜집니다. 에이전트가 프로세스를 직접 죽이면 폰 연결이 끊기므로 지침으로 금지해 두었습니다.
- 절전 끄기 (전원 연결 시): `powercfg /change standby-timeout-ac 0`
- Tailscale serve 설정은 재부팅 후에도 유지됩니다. 해제: `tailscale serve --https=443 off`

이 PC의 주소: `https://leebeegle.tailb35555.ts.net` (Tailscale에 로그인된 기기에서만 열림)

## 구조

```
server/index.js          HTTP + WebSocket + REST
server/runners/claude.js claude -p --output-format stream-json (세션 --resume)
server/runners/codex.js  codex exec --json (thread resume)
server/mcp-approver.js   Claude 권한 프롬프트 → 대시보드 → 폰 (MCP permission-prompt-tool)
server/approvals.js      승인 대기/해결 브리지
public/                  PWA (vanilla JS)
data/                    sqlite, config (git 제외)
```
