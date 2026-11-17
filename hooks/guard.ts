// What the guard looks for: a protected address in the spellings it can read, and the places
// Claude Code and git keep one.

const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi

/** The addresses written in `text`, lowercased. */
export const addressesIn = (text: string): string[] => [...text.matchAll(ADDRESS)].map(m => m[0].toLowerCase())

const GMAIL = new Set(['gmail.com', 'googlemail.com'])
const AT = String.raw`(?:@|%40|&#0*64;|&commat;|\s*[[(]\s*at\s*[\])]\s*)`
const DOT = String.raw`(?:\.|%2e|\s*[[(]\s*dot\s*[\])]\s*)`
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

/**
 * Matches `address` in any case, with any `+tag`, and with `@` and `.` URL-encoded, as HTML
 * entities or spelled out (`[at]`, `(dot)`). A Gmail address also matches with dots anywhere in
 * its user part and at either Gmail domain, since Gmail delivers all of those to one inbox.
 */
export function spelling(address: string): RegExp {
  const at = address.lastIndexOf('@')
  const local = address.slice(0, at).toLowerCase().split('+')[0]!
  const domain = address.slice(at + 1).toLowerCase()
  const isGmail = GMAIL.has(domain)
  const user = isGmail ? [...local.replaceAll('.', '')].map(escape).join(String.raw`\.?`) : escape(local)
  const host = isGmail ? `(?:gmail|googlemail)${DOT}com` : domain.split('.').map(escape).join(DOT)

  return new RegExp(String.raw`${user}(?:\+[a-z0-9._-]*)?${AT}${host}(?![a-z0-9])`, 'gi')
}

/** Whether `text` holds any of the addresses `spellings` match. */
export const holds = (text: string, spellings: readonly RegExp[]) => spellings.some(re => text.search(re) !== -1)

/** Where an address is kept, and what reaching for it reads as in the ask. */
const PLACES: readonly { pattern: RegExp; what: string }[] = [
  { pattern: /\.claude\.json/i, what: 'names .claude.json, where Claude Code keeps your account email' },
  { pattern: /\.credentials\.json/i, what: "names .credentials.json, Claude Code's sign-in file" },
  { pattern: /\boauthAccount\b/i, what: 'reads your Claude account details (oauthAccount)' },
  { pattern: /\bCLAUDE_CODE_USER_EMAIL\b/i, what: 'reads CLAUDE_CODE_USER_EMAIL' },
  { pattern: /\bclaude\s+auth\b/i, what: 'runs claude auth, which prints your account email' },
  {
    pattern: /\bgit\b.{0,200}?\buser\.email\b|\bGIT_(?:AUTHOR|COMMITTER)_(?:EMAIL|IDENT)\b/i,
    what: 'reads or sets your git email',
  },
]

/**
 * Why a tool call whose input reads as `text` should be put to the person, or undefined when it
 * needn't be. The reason never holds the address: where nobody can be asked, the model reads it.
 */
export function concern(text: string, spellings: readonly RegExp[]): string | undefined {
  if (holds(text, spellings)) return 'contains your email address'

  return PLACES.find(p => p.pattern.test(text))?.what
}

/** A `# userEmail` section, as the engine announces the context blocks of a re-read. */
const EMAIL_SECTION = /^# userEmail\n[\s\S]*?(?=^# |(?![\s\S]))/m

/** `text` without a `# userEmail` section, and the addresses that section named. */
export function withoutEmailSection(text: string): { text: string; addresses: string[] } {
  const section = text.match(EMAIL_SECTION)
  if (section === null) return { text, addresses: [] }

  return { text: text.replace(EMAIL_SECTION, ''), addresses: addressesIn(section[0]) }
}

export const REDACTED = '[email redacted]'

/** `value` with every string's matches of `spellings` replaced, its shape kept. */
export function redact<T>(value: T, spellings: readonly RegExp[]): T {
  if (typeof value === 'string') return spellings.reduce<string>((s, re) => s.replace(re, REDACTED), value) as T
  if (Array.isArray(value)) return value.map(v => redact(v, spellings)) as T
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, spellings)])) as T
  }

  return value
}
