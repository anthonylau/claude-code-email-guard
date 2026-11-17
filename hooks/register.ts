import type { EngineInterface, Register, ToolCallResult } from 'claude-code'

import { addressesIn, concern, holds, redact, spelling, withoutEmailSection } from './guard'

/**
 * The account's address as Claude Code reads it: `CLAUDE_CODE_USER_EMAIL`, and `oauthAccount`
 * in `.claude.json` (under `CLAUDE_CONFIG_DIR` when set, else the home directory).
 */
async function accountAddresses($: EngineInterface): Promise<string[]> {
  const found: string[] = []
  const fromEnv = await $.env.get('CLAUDE_CODE_USER_EMAIL')
  if (fromEnv) found.push(fromEnv)

  const dir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))
  if (dir === undefined) return found
  try {
    const config = JSON.parse(await $.fs.read(`${dir}/.claude.json`)) as { oauthAccount?: { emailAddress?: unknown } }
    const address = config.oauthAccount?.emailAddress
    if (typeof address === 'string') found.push(address)
  } catch {
    // No config yet, or signed in with an API key: the context block, if any, still names one.
  }

  return found
}

export const register: Register = on => {
  // Lowercased address to its spelling. Read again at each load, so a reload loses nothing.
  const known = new Map<string, RegExp>()
  const remember = (addresses: readonly string[]) => {
    for (const a of addresses) if (!known.has(a.toLowerCase())) known.set(a.toLowerCase(), spelling(a))
  }

  on('session.start', async ($, e, next) => {
    remember(await accountAddresses($))
    // A load into a running session (an install, an enable, a reload) finds its context and
    // reminders rendered without these hooks: have the engine render them again through them.
    if (await $.session.turns().then(n => n > 0, () => true)) {
      $.ui.invalidate('prompt.context')
      $.ui.invalidate('prompt.attachment')
    }

    return next(e)
  })

  // The first message's `userEmail` block is how the model learns the address: drop it.
  on('prompt.context', async ($, e, next) => {
    const context = await next(e)
    const block = context.blocks.find(b => b.name === 'userEmail')
    if (block === undefined) return context

    remember(addressesIn(block.text))

    return { ...context, blocks: context.blocks.filter(b => b !== block) }
  })

  // What the engine injects on its own reaches the model outside the first message and a tool's
  // result: a re-read context's announcement (which names the userEmail block again), a mentioned
  // file, a hook's context. Drop the section, redact the address, or leave the attachment out.
  on('prompt.attachment', async (_$, e, next) => {
    const { text } = await next(e)
    if (text === null) return { text }

    const stripped = withoutEmailSection(text)
    remember(stripped.addresses)
    const spellings = [...known.values()]

    return { text: holds(stripped.text, spellings) ? redact(stripped.text, spellings) : stripped.text }
  }).catch(() => ({ text: null }))

  // An ask a hook makes is the person's: no allow rule or auto-mode classifier settles it, and
  // where nobody can be asked it is a deny, the reason the model's error. The terminal's dialog
  // doesn't show the reason, so a toast does.
  on('tool.check', async ($, e, next) => {
    const what = concern(JSON.stringify(e.input) ?? '', [...known.values()])
    if (what === undefined) return next(e)

    const verdict = await next(e)
    if (verdict.decision === 'deny') return verdict

    const reason = `${$.plugin.name}: this ${e.tool} call ${what}.`
    if (e.tool_use_id !== undefined) $.ui.toast(reason, { timeoutMs: 20_000 })

    return { decision: 'ask' as const, reason }
  }).catch($ => ({ decision: 'ask', reason: `${$.plugin.name}: its check failed, so it asks.` }))

  // Redacts the address from what a tool answered, so reading a file or a log can't teach it.
  on('tool.call', async ($, e, next): Promise<ToolCallResult> => {
    const ran = await next(e)
    const spellings = [...known.values()]
    if (ran.deny !== undefined || spellings.length === 0) return ran
    if (!holds(ran.text ?? JSON.stringify(ran.result) ?? '', spellings)) return ran

    const withheld = { deny: `${$.plugin.name}: the result held your email address, so it was withheld.` }
    // Only in the text core made for the model, not in the record a hook can rewrite.
    if (!holds(JSON.stringify(ran.result) ?? '', spellings)) return withheld

    const result: unknown = redact(ran.result, spellings)
    const context = ran.context && redact(ran.context, spellings)

    return ran.isError === true
      ? { isError: true, result, text: ran.text && redact(ran.text, spellings), context }
      : ({ result, context } as ToolCallResult)
  }).catch(($, e, next) =>
    next.called ? { deny: `${$.plugin.name}: its redaction failed, so the result was withheld.` } : next(e),
  )
}
