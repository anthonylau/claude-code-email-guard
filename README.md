# Email Guard for Claude Code

**Keep your Claude account email away from the model.**

Claude Code tells the model your account email at the start of every conversation. From there it
can end up in a commit, a sign-up form, an API request or a file. Email Guard is a Claude Code mod
(early access) that stops that:

- **The model never sees your email.** It is removed from the conversation before the model reads
  it.
- **You're asked before it's used.** Any tool call that contains your email, or reads where it is
  stored, needs your approval every time. Allow rules and auto mode can't approve it for you.
- **It's redacted from what the model reads.** If your email shows up in a file, `git log`, a web
  page or a file you @-mention, the model sees `[email redacted]` instead.

## Install

```sh
claude plugin marketplace add anthonylau/claude-code-email-guard
claude plugin install email-guard@email-guard
```

Then start a new session. Installed into a running session, it has Claude Code render the
context again without your email, but the model may already have read it in an earlier turn.

## Limits

- It guards your Claude account email only. Your git `user.email` can be a different address, and
  commits made with it are untouched.
- Text matching can't catch an email that is assembled at run time, such as a script that reads
  `.claude.json` and sends it on, or a base64-encoded copy. Hiding the email from the model covers
  most of those cases, because the model can't encode an address it doesn't know. An email you
  type into a prompt yourself is yours to share, and the model sees it.
- If the model reads a file with the address redacted and then edits it, the edit can fail to
  match the original text where the address was.

It works alongside Claude Code's built-in privacy mod (`cc-plugin-privacy`): a call that mod refuses
stays refused, with its reason.

Written and tested on Claude Code 2.1.327. The mod API may change between releases without notice.

## How it works

Email Guard is a [mod](https://github.com/anthropics/claude-code/tree/main/mods): a plugin whose
`hooks/register.ts` hooks the engine's events.

| Event               | What it does                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.start`     | reads the address from `oauthAccount` in `.claude.json` (under `CLAUDE_CONFIG_DIR` if set) and `CLAUDE_CODE_USER_EMAIL`; in a running session, re-renders the context |
| `prompt.context`    | drops the `userEmail` block, adding the address it names                                                                                                              |
| `prompt.attachment` | drops the `userEmail` section a context re-read announces, and redacts the address from reminders, @-mentioned files and hook context                                 |
| `tool.check`        | asks for a call that holds the address or reaches where it is kept, unless the engine already denies it                                                               |
| `tool.call`         | redacts the address from the result, or withholds a result it can't redact                                                                                            |

When nobody is there to approve a call, as in a background subagent or `claude -p`, the call is
refused. A toast explains why a call was flagged, since the terminal's permission dialog doesn't.

### What counts as your email

The address matches in any case, with any `+tag`, with `@` and `.` URL-encoded (`%40`), as HTML
entities, or spelled out (`[at]`, `(dot)`). A Gmail address also matches with dots anywhere in
its user part and at `googlemail.com`, since Gmail delivers all of those to one inbox.

A call also asks for approval when its input names any of these, even without the address:

| Pattern                                                    | Why                                        |
| ---------------------------------------------------------- | ------------------------------------------ |
| `.claude.json`                                             | where Claude Code keeps your account email |
| `.credentials.json`                                        | Claude Code's sign-in file                 |
| `oauthAccount`, `CLAUDE_CODE_USER_EMAIL`                   | your account details                       |
| `claude auth`                                              | prints your account email                  |
| `git … user.email`, `GIT_{AUTHOR,COMMITTER}_{EMAIL,IDENT}` | reads or sets your git email               |

A tool result that can't be redacted is withheld, and so is a reminder the mod fails to check.

## Development

Run from source:

```sh
git clone https://github.com/anthonylau/claude-code-email-guard
claude --plugin-dir ./claude-code-email-guard
```

Test:

```sh
claude plugin validate .
claude plugin test .    # 14 tests, claude-code/testing kit
```

## License

MIT
