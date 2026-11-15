import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ApprovalMode, DraftImage, ModelChoice, RuntimeInfo } from '../types.js';
import type { ReactNode } from 'react';
import { readImage } from '../image-input.js';
import { useDictation } from '../use-dictation.js';
import { Button, Icon, IconButton } from './ui.js';
import { Popover } from './popover.js';
import { ModelSelector } from './model-selector.js';
import { useModelSelection } from '../use-model-selection.js';
import { ApprovalSelector } from './approval-selector.js';
import { ContextMeter } from './context-meter.js';
import { MessageQueue } from './message-queue.js';
import { Feedback } from './feedback.js';
import { moveHistory, type ComposerHistory } from '../composer-state.js';
import { commandMenu, matchCommand, suggestCommands, type CommandSpec } from '../../../src/commands/registry.js';
import { moveCommandIndex } from '../commands/command-menu.js';
import { CommandMenu } from './command-menu.js';
interface ComposerProps {
  context?: ReactNode;
  queuedMessages?: import('../types.js').SessionPayload['queuedMessages'];
  onQueueAction: (id: string, action: 'steer' | 'remove') => Promise<void>;
  runtime?: RuntimeInfo;
  contextTokens?: number | null;
  models: ModelChoice[];
  draft: string;
  history: readonly string[];
  images: DraftImage[];
  onImages: (images: DraftImage[]) => void;
  busy: boolean;
  disabled: boolean;
  changing: boolean;
  modelChanging: boolean;
  onDraft: (text: string) => void;
  onSend: (text: string, images?: DraftImage[]) => Promise<void>;
  onStop: () => void;
  onCommand: (name: string) => Promise<void> | void;
  onModel: (model: ModelChoice) => Promise<boolean>;
  onReasoning: (value: string) => Promise<boolean>;
  onApprovalMode: (mode: ApprovalMode) => Promise<void>;
  onDetails: () => void;
}
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(props, forwardedRef) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const sending = useRef(false);
  const history = useRef<ComposerHistory | null>(null);
  const historyCaret = useRef<'start' | 'end' | null>(null);
  // Tracks the newest draft so a failed send only restores text the owner has
  // not replaced in the meantime.
  const latestDraft = useRef(props.draft);
  latestDraft.current = props.draft;
  const [pending, setPending] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The row the arrow keys are on in the slash menu; reset on every keystroke,
  // because a shorter list must not leave the selection on a row that left it.
  const [commandIndex, setCommandIndex] = useState(0);
  // Surface commands whose controls live in this composer: the approval picker,
  // the page the model picker opens on, and the /help notice.
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [modelPage, setModelPage] = useState<'reasoning' | 'models' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const modelSelection = useModelSelection(props.runtime, props.models, props.onModel, props.onReasoning);
  const dictation = useDictation((text) => props.onDraft([props.draft, text].filter(Boolean).join(' ')), setError);
  useLayoutEffect(() => {
    const node = input.current;
    const form = node?.form;
    if (!node || !form) return;
    // Measuring must not shrink the dock and clamp the transcript's scrollTop.
    const minHeight = form.style.minHeight;
    form.style.minHeight = `${form.getBoundingClientRect().height}px`;
    node.style.height = 'auto';
    node.style.height = `${Math.min(200, Math.max(42, node.scrollHeight))}px`;
    form.style.minHeight = minHeight;
    if (historyCaret.current) {
      const position = historyCaret.current === 'start' ? 0 : node.value.length;
      node.setSelectionRange(position, position);
      historyCaret.current = null;
    }
  }, [props.draft]);
  // Images close the menu: a slash typed beside a picture is part of a message.
  const commands = props.images.length > 0 ? [] : suggestCommands(props.draft, 'web');
  const activeIndex = commands.length ? Math.min(commandIndex, commands.length - 1) : 0;
  const activeCommand = commands[activeIndex];
  useEffect(() => {
    setCommandIndex(0);
  }, [props.draft]);
  /**
   * Runs a command the owner picked from the menu.
   *
   * The words are an instruction to the interface, so they are dropped here
   * instead of being handed to `onSend`: this is the one gate that keeps
   * `/compact` out of the model's context, and it fires on both the Enter that
   * picks a row and the send button.
   */
  const runCommand = async (spec: CommandSpec) => {
    if (sending.current || props.disabled) return;
    sending.current = true;
    setPending(true);
    setError(null);
    if (dictation.listening) dictation.toggle();
    history.current = null;
    props.onDraft('');
    props.onImages([]);
    try {
      // A surface command moves this interface; only a host command is
      // forwarded to the daemon-backed route.
      if (spec.name === '/permissions') {
        setApprovalOpen(true);
      } else if (spec.name === '/models' || spec.name === '/reasoning') {
        setModelPage(spec.name === '/models' ? 'models' : 'reasoning');
        modelSelection.onOpenChange(true);
      } else if (spec.name === '/help') {
        setNotice(
          'Commands: ' +
            commandMenu('web')
              .map((item) => item.command)
              .join(', ') +
            '.',
        );
      } else {
        await props.onCommand(spec.name);
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      sending.current = false;
      setPending(false);
      input.current?.focus();
    }
  };
  const submit = async () => {
    const text = props.draft.trim();
    if ((!text && !props.images.length) || sending.current || props.disabled || props.modelChanging || readingImages) return;
    // A command only counts when it stands alone; `/compact later` is a message.
    const command = matchCommand(text, 'web');
    if (command) {
      await runCommand(command);
      return;
    }
    sending.current = true;
    setPending(true);
    setError(null);
    if (dictation.listening) dictation.toggle();
    // The draft leaves the box before the round trip, not after it. The input
    // stays enabled and keeps the caret, so the owner can start the next message
    // while this one is on its way; a disabled field would lose focus here.
    const images = props.images;
    history.current = null;
    props.onDraft('');
    props.onImages([]);
    try {
      await props.onSend(text, images);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      // Give the words back unless the owner already started a new message.
      if (!latestDraft.current) props.onDraft(text);
    } finally {
      sending.current = false;
      setPending(false);
      input.current?.focus();
    }
  };
  const addImages = async (files: FileList | null) => {
    if (!files?.length) return;
    if (props.images.length + files.length > 4) {
      setError('You can attach at most four images.');
      return;
    }
    setReadingImages(true);
    setError(null);
    try {
      props.onImages([...props.images, ...(await Promise.all(Array.from(files).map(readImage)))]);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setReadingImages(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };
  const canSend = Boolean(props.draft.trim()) || props.images.length > 0;
  return (
    <div className="composer-dock">
      {error ? (
        <Feedback tone="error" onDismiss={() => setError(null)}>
          {error}
        </Feedback>
      ) : null}
      {notice ? (
        <Feedback tone="neutral" onDismiss={() => setNotice(null)}>
          {notice}
        </Feedback>
      ) : null}
      {props.context}
      <MessageQueue messages={props.queuedMessages} busy={props.busy} disabled={props.disabled} onAction={props.onQueueAction} />
      {commands.length ? (
        <CommandMenu items={commands} activeIndex={activeIndex} onSelect={(spec) => void runCommand(spec)} onHover={setCommandIndex} />
      ) : null}
      <form
        className="composer"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('Files')) event.preventDefault();
        }}
        onDrop={(event) => {
          if (event.dataTransfer.files.length) {
            event.preventDefault();
            if (!props.disabled && !pending && !readingImages) void addImages(event.dataTransfer.files);
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {props.images.length ? (
          <div className="image-previews">
            {props.images.map((image) => (
              <div className="image-preview" key={image.id}>
                <img src={image.dataUrl} alt={image.name} />
                <IconButton
                  icon="x"
                  label={`Remove ${image.name} image`}
                  disabled={pending}
                  onClick={() => props.onImages(props.images.filter((item) => item.id !== image.id))}
                />
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          ref={(node) => {
            input.current = node;
            if (typeof forwardedRef === 'function') forwardedRef(node);
            else if (forwardedRef) forwardedRef.current = node;
          }}
          aria-label="Message OpenButler"
          aria-activedescendant={activeCommand ? `command-${activeCommand.name.slice(1)}` : undefined}
          placeholder="Tell me what to do"
          value={props.draft}
          disabled={props.disabled}
          aria-busy={pending}
          rows={1}
          onPaste={(event) => {
            if (event.clipboardData.files.length) {
              event.preventDefault();
              if (!props.disabled && !pending && !readingImages) void addImages(event.clipboardData.files);
            }
          }}
          onChange={(event) => {
            setError(null);
            history.current = null;
            props.onDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (commands.length) {
              const moved = moveCommandIndex(event.key, activeIndex, commands.length);
              if (moved !== null) {
                event.preventDefault();
                setCommandIndex(moved);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey && activeCommand) {
                event.preventDefault();
                void runCommand(activeCommand);
                return;
              }
              // Escape is swallowed here so the global handler below cannot read
              // it as "stop the run"; the menu closes because the draft empties.
              if (event.key === 'Escape') {
                event.preventDefault();
                props.onDraft('');
                return;
              }
            }
            if (
              (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
              !event.shiftKey &&
              !event.ctrlKey &&
              !event.altKey &&
              !event.metaKey
            ) {
              const node = event.currentTarget;
              const up = event.key === 'ArrowUp';
              // Preserve selection and normal movement within multiline drafts.
              const atEdge = up
                ? !node.value.slice(0, node.selectionStart).includes('\n')
                : !node.value.slice(node.selectionEnd).includes('\n');
              if (node.selectionStart !== node.selectionEnd || !atEdge) return;
              const next = moveHistory(history.current, props.history, props.draft, up ? -1 : 1);
              if (!next) return;
              event.preventDefault();
              const text = next.messages[next.index] ?? next.draft;
              history.current = next.index === next.messages.length ? null : next;
              historyCaret.current = up ? 'start' : 'end';
              props.onDraft(text);
              return;
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-toolbar">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp"
            hidden
            aria-label="Add image"
            onChange={(event) => void addImages(event.target.files)}
          />
          <Popover
            className="attachment-popover"
            label="Add"
            disabled={props.disabled || pending || readingImages}
            trigger={<Icon name="plus" />}
          >
            {(close) => (
              <>
                <Button
                  className="attachment-option"
                  icon="image"
                  onClick={() => {
                    fileInput.current?.click();
                    close();
                  }}
                >
                  Add image
                </Button>
                <Button
                  className="attachment-option"
                  icon="folder"
                  onClick={() => {
                    props.onDetails();
                    close();
                  }}
                >
                  Workspace
                </Button>
              </>
            )}
          </Popover>
          <ApprovalSelector
            value={props.runtime?.approvalMode}
            disabled={props.disabled}
            onChange={props.onApprovalMode}
            open={approvalOpen}
            onOpenChange={setApprovalOpen}
          />
          <span className="spacer" />
          {readingImages ? (
            <span className="upload-status" role="status">
              Preparing image…
            </span>
          ) : null}
          <ContextMeter tokens={props.contextTokens} limit={props.runtime?.contextWindowTokens} />
          <ModelSelector
            {...modelSelection}
            requestedPage={modelPage}
            onOpenChange={(next) => {
              if (!next) setModelPage(null);
              modelSelection.onOpenChange(next);
            }}
            disabled={props.disabled || pending || modelSelection.pending}
          />
          <IconButton
            icon="mic"
            label={dictation.listening ? 'Stop dictation' : 'Dictate'}
            className={dictation.listening ? 'mic-button listening' : 'mic-button'}
            disabled={props.disabled || pending || !dictation.supported}
            title={dictation.supported ? 'Dictate' : 'This browser does not support dictation'}
            onClick={dictation.toggle}
          />
          {canSend ? (
            <IconButton
              type="submit"
              icon="arrow-up"
              label={props.busy ? 'Queue message' : 'Send message'}
              className="send-button"
              disabled={props.disabled || props.modelChanging || pending || readingImages || !canSend}
            />
          ) : props.busy ? (
            // One slot for the action that matters now: send when there is
            // something to send, stop while a run is going and there is not.
            <IconButton icon="square" label="Stop response" className="stop-button" onClick={props.onStop} />
          ) : (
            <IconButton
              icon="audio-lines"
              label={dictation.listening ? 'Stop dictation' : 'Start dictation'}
              className={`send-button voice-button${dictation.listening ? ' listening' : ''}`}
              disabled={props.disabled || pending || readingImages || !dictation.supported}
              onClick={dictation.toggle}
            />
          )}
        </div>
      </form>
    </div>
  );
});
