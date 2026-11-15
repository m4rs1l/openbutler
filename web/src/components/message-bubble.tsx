import { Markdown } from '../markdown.js';
import type { StreamRange } from '../stream-reveal.js';
import type { Entry } from '../types.js';
import { MessageActions } from './message-actions.js';
import { MessageAttachments } from './message-attachments.js';

/**
 * The owner's words: bubble surface plus the copy row that sits outside and
 * below it, revealed on hover (or always, on touch).
 */
export function UserBubble({ entry, sessionId }: { entry: Entry; sessionId: string }) {
  const text = (entry.text ?? '').trimEnd();
  return (
    <div className="ask">
      <div className="ask-bubble">
        <div className="prose">
          <MessageAttachments entry={entry} sessionId={sessionId} />
          {text}
        </div>
      </div>
      <MessageActions text={text} />
    </div>
  );
}

/**
 * The model's words: text plus an optional copy row. Only the final answer
 * earns one, and only once the call site says the turn stopped writing; a
 * work-log message never gets a row.
 */
export function AssistantBubble({
  text,
  reveal,
  showActions = false,
}: {
  text: string;
  reveal?: readonly StreamRange[];
  showActions?: boolean;
}) {
  return (
    <div className="answer">
      <div className="body">
        <Markdown text={text} reveal={reveal} />
      </div>
      {showActions ? <MessageActions text={text} /> : null}
    </div>
  );
}
