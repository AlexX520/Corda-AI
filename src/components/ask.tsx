'use client';
import { isDesk } from '@/lib/roles';
import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageCircleQuestion, Send } from 'lucide-react';
import type { AppState } from '@/lib/types';
import type { AskAnswer } from '@/lib/ask';
import { Button } from './ui/button';

type Turn = { question: string; answer?: AskAnswer; error?: string };

const EXAMPLES = (banker: boolean) =>
  banker
    ? ['How many requests came in today?', 'What’s my day tomorrow?', 'Which meetings lack a banker or room?', 'When was Ford Credit × PIMCO moved?', 'Free slots for Ally Financial and Vanguard on Tuesday']
    : ['What’s my day tomorrow?', 'When was Bayview × PIMCO moved?', 'Free slots for Ford Credit and PIMCO on Wednesday'];

/**
 * Ask Corda v1: read-only questions over the schedule and its history. Answers cite the meetings
 * and history entries they come from; nothing is changed from here.
 */
export function AskPanel({ data, onOpenMeeting, compact = false, conferenceId }: { data: AppState; onOpenMeeting: (id: string) => void; compact?: boolean; conferenceId?: string }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Newest answer in view; the input stays pinned below the thread.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);
  async function ask(q: string) {
    if (q.trim().length < 2 || busy) return;
    setBusy(true);
    setQuestion('');
    setTurns((t) => [...t, { question: q }]);
    try {
      const r = await fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'ask', data: { question: q, conferenceId } }) });
      const out = await r.json();
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? (r.ok ? { ...x, answer: out.result } : { ...x, error: out.error || 'Could not answer.' }) : x)));
    } catch {
      setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, error: 'Could not answer.' } : x)));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }
  return (
    <div className={`ask-panel ${compact ? 'compact' : ''}`}>
      <div className="ask-thread" aria-live="polite" ref={threadRef}>
        {!turns.length && (
          <div className="ask-examples">
            <p className="muted">Answers come from the schedule, open requests and the audit history, with sources. Nothing is changed from here.</p>
            {EXAMPLES(isDesk(data.user.role)).map((x) => (
              <button key={x} onClick={() => ask(x)}>{x}</button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="ask-turn">
            <p className="ask-q">{t.question}</p>
            {t.error && <p className="error">{t.error}</p>}
            {!t.answer && !t.error && <p className="muted"><Loader2 size={13} className="spin" /> Looking it up…</p>}
            {t.answer && (
              <div className="ask-a">
                {t.answer.answer.map((line, k) => <p key={k}>{line}</p>)}
                {t.answer.sources.length > 0 && (
                  <div className="ask-sources">
                    <span>Sources</span>
                    {t.answer.sources.map((s, k) =>
                      s.kind === 'meeting' && data.meetings.some((m) => m.id === s.id) ? (
                        <button key={k} onClick={() => onOpenMeeting(s.id)}>[{k + 1}] {s.label}</button>
                      ) : (
                        <small key={k}>[{k + 1}] {s.label}</small>
                      ),
                    )}
                  </div>
                )}
                {t.answer.llm && <small className="muted">Phrased by the configured LLM from the records above.</small>}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="ask-foot">
        <form className="ask-input" onSubmit={(e) => { e.preventDefault(); void ask(question); }}>
          <MessageCircleQuestion size={16} />
          <input ref={inputRef} autoFocus={compact} aria-label="Ask Corda" placeholder="Ask about the schedule, requests or history…" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} enterKeyHint="send" />
          <Button size="sm" type="submit" disabled={busy || question.trim().length < 2}>{busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Ask</Button>
        </form>
      </div>
    </div>
  );
}

export function AskCorda({ data, onOpenMeeting, conferenceId }: { data: AppState; onOpenMeeting: (id: string) => void; conferenceId?: string }) {
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Ask Corda</h1>
          <p>Questions about meetings, availability and what changed. Read-only.</p>
        </div>
      </div>
      <div className="panel">
        <AskPanel data={data} onOpenMeeting={onOpenMeeting} conferenceId={conferenceId} />
      </div>
    </>
  );
}
