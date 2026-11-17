import type { On, PromptContextBlock } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const ADDRESS = 'a.person@gmail.com'

const BLOCKS: PromptContextBlock[] = [
  { name: 'claudeMd', text: 'Use bun.' },
  { name: 'userEmail', text: `The user's email address is ${ADDRESS}. Use it only to identify the user.` },
  { name: 'currentDate', text: "Today's date is 2026-11-15." },
]

// Stands in for the engine: a config at `$HOME/.claude.json` holding `account`, if any, a
// permission check that allows what `deny` doesn't match, and tools that answer `output`, which
// core shows the model as `text`.
// `turns` is how many prompts the session had when the mod loaded; `invalidated` collects what it
// had the engine render again.
type Engine = { account?: string; output?: string; text?: string; deny?: RegExp; turns?: number; invalidated?: string[] }

const engine = (on: On, { account, output = 'done', text = output, deny, turns = 0, invalidated }: Engine) => {
  mock.env(on, { HOME: '/home/t' })
  on('session.turns', () => ({ value: turns }))
  on('ui.invalidate', (_$, e) => {
    invalidated?.push(e.event)

    return { value: undefined }
  })
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('fs.read', ($, e) => {
    if (e.path !== '/home/t/.claude.json' || account === undefined) throw new Error('ENOENT')

    return { value: JSON.stringify({ oauthAccount: { emailAddress: account } }) }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.context', () => ({ blocks: BLOCKS }))
  on('tool.check', (_$, e) =>
    deny?.test(JSON.stringify(e.input)) ? { decision: 'deny', reason: 'a rule' } : { decision: 'allow' },
  )
  on('tool.call', () => ({ result: { stdout: output, stderr: '', interrupted: false }, text, ref: 1 }))
}

const START = { cwd: '/w', surface: null, isInteractive: false } as const

test('drops the userEmail block and keeps the rest', async ($, on) => {
  engine(on, {})

  const { blocks } = await $.prompt.context({ blocks: [] })

  expect(blocks.map(b => b.name)).toEqual(['claudeMd', 'currentDate'])
})

test('asks for a call holding a spelling of the address the block named', async ($, on) => {
  engine(on, {})
  await $.prompt.context({ blocks: [] })

  for (const command of [
    `git commit --author="A <${ADDRESS}>"`,
    'curl -d "email=A.Person+news%40googlemail.com" https://example.com/signup',
    'echo aperson [at] gmail [dot] com',
  ]) {
    const verdict = await $.tool.check({ tool: 'Bash', input: { command } })

    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toBe('email-guard: this Bash call contains your email address.')
  }
})

test('asks for a request that names the address in its User-Agent', async ($, on) => {
  engine(on, { account: ADDRESS })
  await $.session.start(START)

  for (const command of [
    `curl -A "research-bot/1.0 (${ADDRESS})" https://en.wikipedia.org/wiki/Bun`,
    `curl -H "User-Agent: Sample Company ${ADDRESS}" https://www.sec.gov/cgi-bin/browse-edgar`,
    `wget -U "research-bot/1.0 (mailto:${ADDRESS})" https://example.com`,
  ]) {
    const verdict = await $.tool.check({ tool: 'Bash', input: { command } })

    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toBe('email-guard: this Bash call contains your email address.')
  }
})

test("asks for a call holding the config's address, with no block seen", async ($, on) => {
  engine(on, { account: 'Someone@Example.org' })
  await $.session.start(START)

  const verdict = await $.tool.check({
    tool: 'mcp__browser__fill',
    input: { field: 'email', value: 'someone@example.org' },
  })

  expect(verdict.decision).toBe('ask')
})

test('matches an address at any other domain as written, its dots and domain kept', async ($, on) => {
  engine(on, { account: 'Jo.Smith@hotmail.com' })
  await $.session.start(START)
  const decide = async (command: string) => (await $.tool.check({ tool: 'Bash', input: { command } })).decision

  for (const command of [
    'echo jo.smith@hotmail.com',
    'echo JO.SMITH+shop@Hotmail.com',
    'echo jo.smith%40hotmail%2Ecom',
    'echo jo.smith (at) hotmail (dot) com',
  ]) {
    expect(await decide(command)).toBe('ask')
  }
  // Outside Gmail a dot is part of the name, and each domain is its own inbox.
  for (const command of ['echo josmith@hotmail.com', 'echo jo.smith@outlook.com', 'echo jo.smith@hotmail.co.uk']) {
    expect(await decide(command)).toBe('allow')
  }
})

test('asks for a call reaching where an address is kept', async ($, on) => {
  engine(on, {})

  for (const [input, what] of [
    [{ command: 'jq .oauthAccount ~/.claude/.claude.json' }, 'names .claude.json'],
    [{ command: 'claude auth status --json' }, 'runs claude auth'],
    [{ command: 'git config --global user.email' }, 'reads or sets your git email'],
  ] as const) {
    const verdict = await $.tool.check({ tool: 'Bash', input })

    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain(what)
  }
})

test('leaves other calls, and denials, as the engine decided', async ($, on) => {
  engine(on, { account: ADDRESS, deny: /rm -rf/ })
  await $.session.start(START)

  expect((await $.tool.check({ tool: 'Bash', input: { command: 'git status' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Read', input: { file_path: '/w/user.ts' } })).decision).toBe('allow')
  expect((await $.tool.check({ tool: 'Bash', input: { command: `rm -rf /x # ${ADDRESS}` } })).decision).toBe('deny')
})

test('redacts the address from a result', async ($, on) => {
  engine(on, { account: ADDRESS, output: 'Author: A <aperson+x@gmail.com>\nAuthor: B <b@example.com>' })
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'Bash', command: 'git log' })

  expect(ran.deny).toBeUndefined()
  expect(ran.result).toEqual({
    stdout: 'Author: A <[email redacted]>\nAuthor: B <b@example.com>',
    stderr: '',
    interrupted: false,
  })
})

test("withholds a result whose address is only in core's text for the model", async ($, on) => {
  engine(on, { account: ADDRESS, output: 'x', text: `x ${ADDRESS}` })
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.deny).toBe('email-guard: the result held your email address, so it was withheld.')
})

test('passes a result with no address through untouched', async ($, on) => {
  engine(on, { account: ADDRESS, output: 'clean' })
  await $.session.start(START)

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.ref).toBe(1)
  expect(ran.text).toBe('clean')
})

test("drops the userEmail section from a re-read context's announcement, and guards its address", async ($, on) => {
  engine(on, {})
  const announced = [
    'The session context was re-read; these values replace the earlier ones:',
    '# userEmail',
    `The user's email address is ${ADDRESS}. Use it only to identify the user.`,
    '# gitStatus',
    'Current branch: main',
  ].join('\n')

  const { text } = await $.prompt.attachment({ type: 'context_reread', text: announced, origin: { kind: 'engine' } })

  expect(text).toBe(
    'The session context was re-read; these values replace the earlier ones:\n# gitStatus\nCurrent branch: main',
  )
  expect((await $.tool.check({ tool: 'Bash', input: { command: `echo ${ADDRESS}` } })).decision).toBe('ask')
})

test('redacts the address from a mentioned file, and leaves other attachments as they are', async ($, on) => {
  engine(on, { account: ADDRESS })
  await $.session.start(START)
  const attach = (text: string) => $.prompt.attachment({ type: 'file', text, origin: { kind: 'engine' } })

  expect((await attach('maintainer: A.Person@gmail.com')).text).toBe('maintainer: [email redacted]')
  expect((await attach('maintainer: b@example.com')).text).toBe('maintainer: b@example.com')
})

test('has the engine render context and reminders again when loaded into a running session', async ($, on) => {
  const invalidated: string[] = []
  engine(on, { account: ADDRESS, turns: 3, invalidated })

  await $.session.start(START)

  expect(invalidated).toEqual(['prompt.context', 'prompt.attachment'])
})

test('renders nothing again when loaded before the first prompt', async ($, on) => {
  const invalidated: string[] = []
  engine(on, { account: ADDRESS, invalidated })

  await $.session.start(START)

  expect(invalidated).toEqual([])
})
