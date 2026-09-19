// 담당자 오류를 대표가 읽을 수 있는 한 줄로 바꾸고, 잠깐 기다렸다 다시 하면 될 일인지 가려낸다.
const RULES = [
  [/rate[_ -]?limit|too many requests|429/i, '요청이 너무 몰려 잠시 막혔습니다', true],
  [/usage limit|quota|resource[_ ]exhausted|insufficient_quota|weekly limit|5-hour limit|한도.{0,8}(소진|초과|도달)/i, '구독 사용 한도에 닿았습니다. 한도가 풀리거나 다른 담당자로 바꿔야 합니다', false],
  [/overloaded|529|503|502|500|internal server error|service unavailable/i, 'AI 서버가 잠시 붐빕니다', true],
  [/ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket hang up|getaddrinfo/i, '인터넷 연결이 잠깐 끊겼습니다', true],
  [/timed? ?out|timeout/i, '응답이 너무 오래 걸려 끊었습니다', true],
  [/authentication|unauthorized|401|invalid api key|not logged in|login/i, '로그인이 풀렸습니다. Claude·Codex는 PC에서, Gemini는 앱 설정에서 다시 로그인해야 합니다', false],
  [/max[_ ]turns|error_max_turns/i, '허용된 단계 수를 다 써서 멈췄습니다', false],
  [/error_max_budget_usd|max budget/i, '정해 둔 예산을 다 써서 멈췄습니다', false],
  [/ENOENT.*claude|claude.*not found|spawn.*ENOENT/i, 'Claude 프로그램을 찾지 못했습니다. PC에 설치돼 있는지 확인이 필요합니다', false],
  [/종료 코드 (?!0\b)\d+|exit(?:ed)? (?:code )?(?!0\b)\d+|crashed/i, '담당자 프로그램이 도중에 꺼졌습니다', true],
  [/permission denied|EACCES|EPERM/i, '파일을 만질 권한이 없어 막혔습니다', false],
];

/** { plain, transient } — plain은 한국어 한 줄, transient면 자동으로 한 번 더 시도할 만하다. */
export function explainError(text) {
  const t = String(text || '');
  for (const [re, plain, transient] of RULES) if (re.test(t)) return { plain, transient };
  return { plain: '작업 중 문제가 생겨 멈췄습니다', transient: false };
}

/** 채팅에 보일 문장: 쉬운 설명 + (원문 요약). 원문이 이미 한국어 한 줄이면 그대로. */
export function errorMessageText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '문제가 발생했습니다.';
  const { plain } = explainError(raw);
  if (/^[가-힣\s·.,()0-9]+$/.test(raw) && raw.length <= 80) return raw;
  const short = raw.replace(/\s+/g, ' ').slice(0, 160);
  return `${plain}\n원문: ${short}${raw.length > 160 ? '…' : ''}`;
}
