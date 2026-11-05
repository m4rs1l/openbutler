# Telegram, owner delivery and unified inbox

Contents: setup, lifecycle, commands, delivery, media and notifications.
Related: [environment](environment.md), [teams](teams.md), [workers](workers.md).

## Telegram onboarding

```text
openbutler telegram setup
openbutler telegram status
openbutler telegram pair
```

Setup uses a Telegram bot token from BotFather, referenced by a named host
environment variable. It validates the token, records default workspace scope,
starts/reloads the host, pairs the owner with a one-time command and can send a
test message. The actual token is not a general settings-file field.

For a server with the variable already supplied by its service manager:

```text
openbutler telegram setup --token-env=TELEGRAM_BOT_TOKEN --workspace=/srv/project --no-wait
```

`--no-wait` skips the interactive pairing wait; it does not mean the channel has
been paired. `--skip-test` skips the outbound test. Use `pair` for a fresh code,
send the displayed `/start <code>` to the intended bot, then inspect `status`.
Valid credentials, running polling, correct paired owner and successful delivery
are separate facts.

On Windows, the host can consult user environment storage when its launch shell
has stale variables. On macOS/Linux, managed startup needs its token environment
available to its LaunchAgent/service. Setup refreshes supported startup wiring;
custom service managers must supply the intended environment themselves.

## Channel lifecycle and chat commands

| Command | Result |
| --- | --- |
| `telegram status` | Current channel/pairing/error state |
| `telegram pair` | Fresh one-time pairing command |
| `telegram unpair` | Forget paired chat, keep channel polling |
| `telegram disable` | Stop channel while retaining configuration |
| `telegram reset` | Remove channel configuration |
| `telegram reset --remove-env` | Also remove managed token environment value |

The bot offers `/start`, `/approvals`, `/stop`, `/sessions`.
`/approvals` reissues pending approval controls; `/stop` stops current work and
preserves queued input; `/stop <schedule-id>` targets a schedule run; `/sessions`
lists recent choices. There is no reset command on this channel: chats belong to
the interfaces the owner is looking at, so `/new` and `/clear` are ordinary text
here. The UI can provide live draft/stop and approval controls. Exact
availability depends on current channel/runtime state, not just the configured
tokenEnv name.

## Inbound routing: one target

The paired chat has exactly one target: the custodian conversation. Nothing is
decided per message, so no binding row and no reply-correlation row is written,
and a quoted message cannot address a different session. Legacy
`telegram:binding:<userId>` and `telegram:message:<chatId>:<messageId>` rows from
older builds stay unread. Session switches, host restarts and reconnects cannot
re-point the channel because there is nothing to point.

Incoming Telegram owner messages are authenticated and persisted as owner-inbox
events. Host notification text points to the inbox; the agent reads actual
messages with `inbox`, not by treating a short pointer as the full user request.

## Outbound delivery

The `send_message_to_owner` tool — present only in the custodian runtime — sends intentional outbound messages to
the paired **Telegram** chat; it does not send to the terminal. Inputs are
`text`, optional `imagePath` or `filePath`, and `replyTo` as an array of original
owner inbox message ids. There is no current `channel: auto|terminal|telegram`
input in that tool. Ordinary assistant text and tool activity are not automatically
forwarded as Telegram replies.

The custodian owns this channel. Outbound text carries no sender label and no
message id is recorded for reply correlation: with one target there is nothing to
disambiguate. Which runtimes may call the tool is a separate authority decision,
not a property of the message.

```json
{"text":"The requested inspection is complete.","replyTo":["<owner-message-id>"]}
```

An omitted replyTo can bind to owner messages recently read by the host. An
explicitly proactive message unrelated to those reads can use `replyTo: []`;
a reply uses the actual read message ids. Text
alone, one photo or one document is supported. Photo and document are alternatives.
Use local file paths; a URL is not a local media path. Current photo limit is
10 MB, document limit 50 MB and media caption limit 1024 characters; the tool text
schema permits up to 28000 characters, with delivery splitting as needed. Check
the returned outcome for errors/partial delivery. Long-message delivery tracks
confirmed chunks so a later failure need not replay confirmed ones.

## Unified notification inbox

Tool operations:

```json
{"action":"list","limit":20}
```

```json
{"action":"read","source":"Telegram","limit":20}
```

```json
{"action":"read","ids":["<notification-id>"]}
```

List returns source counts and notification ids without content; use source names
returned there, such as Telegram, Team, Subagent and Agent. Read opens selected ids
or the next unread page; limit is 1-20 and offset is zero-based. Original message
ids used for replies and notification ids used for opening are not interchangeable.

Opening is the only consumption step: reading removes a notification from the
pending inbox without deleting its history, and there is no separate
acknowledgement call. Read notifications do not repeat, including after a new chat
or restart.
Telegram rows are scoped to the line's target session: other sessions see no
Telegram items and cannot consume an unread one, while already-read history
stays readable from any owner session.
Only unread notifications are reminded, at five-minute intervals. Reply through
the source tool with its message identity when needed. Check
`errors` as well as `remaining`: an unavailable adapter is not an empty inbox.
Subagent reports are marked consumed after they are saved in the parent's
conversation. Worker access is source/relationship limited; an explorer cannot
use inbox to impersonate owner/team access outside its assigned tool set.

## Troubleshoot

| Symptom | Inspect |
| --- | --- |
| Bot auth fails | Variable name, host account and token validation result |
| Polling but no owner input | Paired chat/user and fresh pairing code |
| User cannot see assistant reply | Was an explicit owner-send operation delivered? |
| Repeated notification | Whether its content was read; only unread items receive five-minute reminders |
| Missing image/file | Local staged path, media validation and channel limit |
| Works interactively, not at login | Startup-service environment and active host identity |
| Answer arrived from another session | The `[title]` origin label names the sending session; quote that message on Telegram to continue in it |

Owner stop prevents automatic waking until explicitly released. Notifications
are durable pointers; they are not proof a remote action succeeded or a fresh
grant of permission.
