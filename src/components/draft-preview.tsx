'use client';
import { useEffect, useState } from 'react';
import { PenLine } from 'lucide-react';
import { CordaMark } from './ui/corda-mark';

type Preview = { to: string[]; cc: string[]; subject: string; body: string; assumed?: boolean };

/**
 * The reply Corda drafted, laid out like the email it will be (To, Subject, paragraphs, sign-off),
 * so it can be read at a glance before opening the editor to change or send it. While a prepared
 * change is still pending, the preview is worded as it will read once that change is approved.
 */
export function DraftPreview({ emailId, version, onEdit }: { emailId: string; version: string; onEdit: () => void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'replyPreview', data: { emailId, assumeApproved: true } }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((out) => live && setP(out.result))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [emailId, version]);
  if (failed) return null;
  // Paragraphs are split on blank lines; single line breaks stay (sign-offs, lists).
  const paras = (p?.body || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  return (
    <section className="dc-draft-preview" aria-label="Draft reply">
      <div className="head">
        <span className="title">
          <CordaMark size={18} /> Draft reply
          {p?.assumed && <span className="sub">· after approval</span>}
        </span>
        <button className="v5-btn quiet" onClick={onEdit} disabled={!p}>
          <PenLine size={14} /> Edit and send
        </button>
      </div>
      {p ? (
        <div className="mail">
          <dl>
            <dt>To</dt>
            <dd>{p.to.length ? p.to.join(', ') : 'Choose a recipient'}</dd>
            {p.cc.length > 0 && (
              <>
                <dt>Cc</dt>
                <dd>{p.cc.join(', ')}</dd>
              </>
            )}
            <dt>Subject</dt>
            <dd>{p.subject}</dd>
          </dl>
          <div className="body">
            {paras.map((x, i) => (
              <p key={i}>
                {x.split('\n').map((line, j, all) => (
                  <span key={j}>
                    {line}
                    {j < all.length - 1 && <br />}
                  </span>
                ))}
              </p>
            ))}
          </div>
        </div>
      ) : (
        <div className="mail loading" aria-busy="true">
          <span />
          <span />
          <span />
        </div>
      )}
    </section>
  );
}
