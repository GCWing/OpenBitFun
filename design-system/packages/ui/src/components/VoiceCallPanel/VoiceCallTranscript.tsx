import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { classNames } from "../../internal/classNames";
import styles from "./VoiceCallPanel.module.css";

const useReadingLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export interface VoiceTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "status";
  content: ReactNode;
  /** Host-owned transient feedback beneath the message, outside its bubble. */
  activity?: ReactNode;
}

export interface VoiceCallTranscriptProps {
  entries: readonly VoiceTranscriptEntry[];
  status?: ReactNode;
  header?: ReactNode;
  className?: string;
  compact?: boolean;
  /** Chat uses FlowChat message tokens; voice retains the inverse call surface. */
  presentation?: "voice" | "chat";
  /** Requests older records when the reader scrolls toward the start. The host owns paging and retries. */
  onLoadEarlier?: () => void;
}

/** One reading viewport for both text and voice. The host owns the records. */
export function VoiceCallTranscript({ entries, status, header, className, compact, presentation = "voice", onLoadEarlier }: VoiceCallTranscriptProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followsLatest = useRef(true);
  const anchor = useRef<{ id: string; offset: number } | null>(null);
  const previousScrollTop = useRef(0);
  const [scrolled, setScrolled] = useState(false);

  const captureAnchor = () => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const top = viewport.getBoundingClientRect().top;
    const first = Array.from(viewport.querySelectorAll<HTMLElement>('[data-transcript-id]'))
      .find(element => element.getBoundingClientRect().bottom > top);
    anchor.current = first ? { id: first.dataset.transcriptId!, offset: first.getBoundingClientRect().top - top } : null;
  };

  const restoreReadingPosition = () => {
    const viewport = viewportRef.current;
    if (!viewport || !viewport.clientHeight) return;
    if (followsLatest.current) {
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
    } else if (anchor.current) {
      const saved = anchor.current;
      const element = Array.from(viewport.querySelectorAll<HTMLElement>('[data-transcript-id]'))
        .find(candidate => candidate.dataset.transcriptId === saved.id);
      if (element) viewport.scrollTop += element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - saved.offset;
    }
    previousScrollTop.current = viewport.scrollTop;
    setScrolled(viewport.scrollTop > 1);
    captureAnchor();
  };

  const requestEarlier = () => {
    const viewport = viewportRef.current;
    if (!onLoadEarlier || !viewport?.clientHeight || viewport.scrollTop > 80) return;
    // A short transcript can page upward too. Hold its first visible row while
    // older records arrive instead of following the bottom.
    followsLatest.current = false;
    captureAnchor();
    onLoadEarlier();
  };

  useReadingLayoutEffect(restoreReadingPosition, [entries, status, header]);
  useReadingLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(restoreReadingPosition);
    if (viewportRef.current) observer.observe(viewportRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, []);

  return <div ref={viewportRef} className={classNames(styles.conversation, compact && styles.compactTranscript, className)}
    data-openbitfun-component="voice-call-panel" data-openbitfun-part="conversation"
    data-openbitfun-presentation={presentation}
    data-scrolled={scrolled || undefined}
    tabIndex={0}
    onWheel={event => { if (event.deltaY < 0) requestEarlier(); }}
    onKeyDown={event => {
      if (event.target === event.currentTarget && ["ArrowUp", "PageUp", "Home"].includes(event.key)) requestEarlier();
    }}
    onScroll={() => {
      const element = viewportRef.current;
      if (!element || !element.clientHeight) return;
      const scrollingUp = element.scrollTop < previousScrollTop.current;
      previousScrollTop.current = element.scrollTop;
      setScrolled(element.scrollTop > 1);
      followsLatest.current = element.scrollHeight - element.clientHeight - element.scrollTop < 24;
      captureAnchor();
      if (scrollingUp) requestEarlier();
    }}>
    <div ref={contentRef} className={styles.entries} data-openbitfun-part="entries">
      {header}
      {entries.map(entry => <div key={entry.id} data-transcript-id={entry.id} className={styles.entry}>
        <div className={styles[entry.role]} data-openbitfun-part={entry.role === "status" ? "status" : `${entry.role}Transcript`}>
          {entry.content}
        </div>
        {entry.activity && <div className={styles.activity} data-openbitfun-part="entryActivity" data-role={entry.role}>
          {entry.activity}
        </div>}
      </div>)}
      {status && <div className={styles.status} role="status" data-openbitfun-part="status">{status}</div>}
    </div>
  </div>;
}
