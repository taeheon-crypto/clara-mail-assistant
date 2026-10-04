# Clara — Gmail + Calendar AI Assistant

Next.js(App Router) 백엔드 위에, 기존에 만들어둔 정적 단일 HTML(`public/app.html`)을 프런트엔드로 쓰는 구조.
`public/app.html`이 UI 전체(이메일/캘린더/AI챗 화면, CSS, 클라이언트 JS)를 담당하고, Next.js는 그 뒤에서
Gmail/Calendar API 호출과 OAuth 토큰 관리만 해주는 얇은 백엔드 역할.

- Live: https://clara-app-drab.vercel.app
- Repo: https://github.com/taeheon-crypto/clara-mail-assistant
- Vercel 프로젝트: `bba-th/clara-app`

## 공통 온톨로지 (2026-10-04)

메일·캘린더·모든 AI 챗이 `public/ontology-core.mjs`의 공통 관계 모델을 사용한다.
사람(이메일 주소), 이메일(Gmail ID), 대화(thread ID), 일정(calendar ID + event ID),
도메인, 프로젝트, 업무 후보, 첨부파일과 각 관계의 원본 근거를 보존한다.
동명이인은 합치지 않는다. 이메일 도메인은 실제 소속 회사로 단정하지 않는다.
제목의 `[태그]`와 요청 문장으로 추출한 프로젝트·업무는 **후보**이며,
지식 연결 패널에서 사용자가 연결한 프로젝트는 확정 관계로 구분한다.

- 사이드바 **지식 연결** 아이콘: 검색, 종류별 필터, 관계/근거 확인, 프로젝트 연결.
- 메일 제목 행 및 일정 팝업의 지식 연결 버튼: 해당 원본의 관계를 확인.
- `/api/ontology/sync`: 로그인한 사용자의 전체 Gmail(보낸메일·보관메일·스팸·휴지통 포함),
  전체 캘린더 목록, 모든 저장된 일정/반복 시리즈를 페이지 단위로 읽는다.
  반복 시리즈는 개별 미래 발생 일정으로 전개하지 않는다. 첨부파일은 메타데이터만 색인한다.
- 초기 수집은 로그인 후 자동 진행된다. 일시정지/재개와 요청 한도 대기 후 동일 페이지 재시도를 지원한다.
  메일 페이지는 일부만 성공하면 커서를 넘기지 않는다. 패널에서 완료 여부를 확인할 수 있다.
- 계정별 IndexedDB에 원본 데이터, 진행 커서, 수동 프로젝트 연결을 저장한다.
  **브라우저 내 저장이며 서버 DB/기기 간 동기화는 아직 없다.** 저장 실패 시 메모리 모드임을 표시한다.
  저장된 완료 인덱스는 새로 동기화 버튼으로 갱신하며, 메일/일정 변경 시 오래된 인덱스로 표시한다.
  전체 재수집 시 사라진 원본은 제거하고, 남아 있는 원본에 대한 사용자 프로젝트 연결은 유지한다.
- 기존 여섯 AI 호출은 `ontology-bridge.js`를 통해 공통 인덱스를 조회한다.
  관련 객체와 두 단계 관계, ISO 날짜/사용자 시간대 기준 집계, 수집 범위를 전달한다.
  미완료 인덱스의 건수를 전체 건수로 표현하지 않도록 하고, 원본 ID를 근거로 답변하도록 한다.
  메일 본문은 최대 24,000자 색인하고 AI에는 관련 본문의 일부만 전달한다.
  키워드/관계 조회 기반이며 임베딩 검색과 LLM 기반 엔티티 추출은 아직 없다.

검증: `npm test` (관계/동명이인/후보와 확정/시간대 집계/근거 조회/API 인증/페이지와 요청 한도/AI 컨텍스트),
`npm run build`. 테스트는 합성 데이터와 모의 Google/OpenRouter 응답을 사용한다.

## 아키텍처 핵심

- **인증**: Auth.js(NextAuth v5), `src/auth.ts`. Google OAuth, JWT 세션. refresh_token을 JWT 안에 넣어두고
  `jwt()` 콜백에서 만료 시 자동 갱신 → DB 없이 로그인 유지됨.
- **프런트**: `public/app.html` 하나가 전부. React 컴포넌트 아님, 순수 DOM 조작 vanilla JS. 백엔드 API는
  전부 `/api/gmail/*`, `/api/calendar/*`, `/api/chat`를 `fetch`로 호출.
- **AI 챗**: `/api/chat`이 OpenRouter를 Anthropic Messages API 포맷으로 감싸서 프록시함
  (`{system, messages} → {content:[{text}]}`). 현재 모델은 무료(`google/gemma-4-26b-a4b-it:free`, cost 0 확인됨).
  DeepSeek 무료 티어는 2026-10 기준 전부 종료됨 — 다시 켜질 수도 있으니 OpenRouter에서 재확인해볼 것.

## 환경변수 (`.env.local`, git에 없음 — 직접 채워야 함)

| 변수 | 용도 | 발급처 |
|---|---|---|
| `AUTH_SECRET` | NextAuth 세션 암호화 | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` 로 생성 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth | Google Cloud Console → API 및 서비스 → 사용자 인증 정보 |
| `OPENROUTER_API_KEY` | AI 챗 | openrouter.ai 대시보드 |
| `APP_URL` | OAuth referer 등에 사용 | 배포 도메인 |

Vercel에는 이미 다 등록돼 있음 (`vercel env ls`로 확인). **PowerShell로 `vercel env add`할 때 파이프로
값을 넘기면 UTF-8 BOM이 앞에 섞여 들어가서 client_id가 깨지는 버그를 겪었음** — 반드시 BOM 없는 파일로
만들어서 리다이렉트로 넣을 것 (`[System.IO.File]::WriteAllText($tmp, $value, (New-Object System.Text.UTF8Encoding $false))`).

### Google Cloud Console에서 필요한 설정
1. **API 활성화**: Gmail API, Google Calendar API (둘 다 "라이브러리"에서 따로 활성화 필요 — 안 하면 403 "has not been used in project" 에러)
2. **OAuth 동의 화면 → 데이터 액세스**에 아래 스코프 전부 추가 (코드에서 요청해도 콘솔에 안 올려두면 거부됨):
   - `gmail.readonly`, `gmail.modify`, `gmail.send`, `gmail.settings.basic` (발신자 차단용 필터 생성), `calendar`
3. **대상 → 테스트 사용자**에 로그인할 계정 추가 (앱이 "테스트" 상태라 미등록 계정은 로그인 자체가 막힘)
4. **사용자 인증 정보 → 클라이언트**에 승인된 JavaScript 원본/리디렉션 URI로 배포 도메인 + `/api/auth/callback/google` 추가
5. 스코프를 새로 추가할 때마다 **기존 로그인 세션은 재로그인해야** 새 스코프가 토큰에 반영됨 (로그아웃 → 재로그인)

## 겪었던 큰 버그들 (재발 방지용 기록)

1. **`.fp`/`.el` CSS 기본값이 "숨김" 상태** (`opacity:0`, `transform:translateX(-20px)`, `max-width:0`) —
   원래 "페이지 최초 로드 진입 애니메이션"의 시작점으로 설계된 값인데, 어딘가에서 `.style.transform = ''`
   처럼 빈 문자열로 인라인 스타일을 지우면 이 숨김 기본값으로 떨어져서 사이드바 글자가 잘리거나 패널이
   사라지는 버그가 생김. **절대 `''`로 리셋하지 말고 `'translateX(0)'`/`'1'`/`'333px'` 등 명시적인 값으로
   설정할 것.** (`_resetPanelTransitionArtifacts`, `_syncSidebarFinalState` 참고)
2. **Gmail API 분당 할당량(Quota)**: 메일 목록/본문을 한꺼번에 많이/병렬로 요청하면
   `Quota exceeded for quota metric 'Total Query Cost'` 403이 뜸. 배치 크기를 작게(5개씩), 프리페치
   상한을 적당히(40통) 유지할 것. 멀티 디바이스 동시 로그인 시 더 잘 터짐.
3. **AI 챗에 이메일 전체 목록을 안 주면** "이번주 메일 몇 개?" 같은 집계 질문에 키워드 매칭된 몇 개만
   보고 엉뚱하게 답함 → `/api/chat` 호출 시 항상 전체 `EMAILS` 목록(날짜 포함, 가볍게)을 같이 넘길 것.
4. **PowerShell로 `vercel env add`에 파이프로 값 전달 시 BOM 삽입됨** (위 참고).

## 로컬 개발

```bash
npm install
npm run dev   # http://localhost:3000
```

Google OAuth는 `file://`나 임의 포트에서 안 됨 — Google Cloud Console에 등록된 origin/redirect URI와
정확히 일치하는 호스트로만 접속해야 함 (지금은 `http://localhost:3000`과 배포 도메인만 등록돼 있음).

## 배포

```bash
npm run build        # 먼저 로컬 빌드로 타입/문법 에러 확인
git add -A && git commit -m "..." && git push
npx vercel --prod --yes --force
```

GitHub push와 Vercel 배포가 자동 연동되어 있지 않음 (수동으로 `vercel --prod` 실행해야 실제 배포됨).
