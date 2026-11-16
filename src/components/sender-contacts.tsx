'use client';
import { useState } from 'react';
import { X } from 'lucide-react';
import type { AppState } from '@/lib/types';
import { Button } from './ui/button';
import type { Run } from './shared';

/**
 * Extra sender addresses per company, e.g. a test mailbox (Tao and Alex test from school or
 * personal addresses, which would otherwise show as unregistered senders).
 */
export function SenderContacts({ data, run }: { data: AppState; run: Run }) {
  const companies = [
    ...data.issuers.map((i) => ({ kind: 'issuer' as const, id: i.id, name: i.name, list: (i as { extraContacts?: string[] }).extraContacts || [] })),
    ...data.investors.map((i) => ({ kind: 'investor' as const, id: i.id, name: i.name, list: (i as { extraContacts?: string[] }).extraContacts || [] })),
  ];
  const [email, setEmail] = useState('');
  const [pick, setPick] = useState(`issuer:${data.issuers[0]?.id || ''}`);
  const [busy, setBusy] = useState(false);
  const listed = companies.flatMap((c) => c.list.map((e) => ({ ...c, email: e })));
  const save = async (kind: string, id: string, address: string, remove = false) => {
    setBusy(true);
    const ok = await run('senderContact', { kind, id, email: address, remove }, remove ? 'Address removed.' : `Emails from ${address} now count as that company.`);
    setBusy(false);
    if (ok && !remove) setEmail('');
  };
  return (
    <section className="panel v5-senders">
      <h3>Extra sender addresses</h3>
      <p className="muted-line">
        Emails from these exact addresses count as the company, e.g. a test mailbox or an assistant’s personal address. Everything else from an unregistered domain stays
        flagged.
      </p>
      {listed.length > 0 && (
        <ul>
          {listed.map((x) => (
            <li key={`${x.kind}:${x.id}:${x.email}`}>
              <strong>{x.email}</strong>
              <span>→ {x.name} ({x.kind})</span>
              <button className="v5-icon" aria-label={`Remove ${x.email}`} disabled={busy} onClick={() => save(x.kind, x.id, x.email, true)}>
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="add">
        <input aria-label="Sender address" placeholder="name@school.edu" value={email} onChange={(e) => setEmail(e.target.value)} />
        <select aria-label="Company" value={pick} onChange={(e) => setPick(e.target.value)}>
          <optgroup label="Issuers">
            {companies.filter((c) => c.kind === 'issuer').map((c) => (
              <option key={c.id} value={`issuer:${c.id}`}>{c.name}</option>
            ))}
          </optgroup>
          <optgroup label="Investors">
            {companies.filter((c) => c.kind === 'investor').map((c) => (
              <option key={c.id} value={`investor:${c.id}`}>{c.name}</option>
            ))}
          </optgroup>
        </select>
        <Button disabled={busy || !/.+@.+\..+/.test(email)} onClick={() => save(pick.split(':')[0], pick.split(':')[1], email.trim())}>
          Add
        </Button>
      </div>
    </section>
  );
}
