'use client';
import { useState } from 'react';
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Upload } from 'lucide-react';
import type { Difference } from '@/lib/syndicate';
import { Button } from './ui/button';
import type { Run } from './shared';

type Result = { matched: number; rows: number; ours: number; differences: Difference[]; missing: string[]; sampleCsv: string; fileName: string };

const GROUPS: { kind: Difference['kind']; title: string; hint: string }[] = [
  { kind: 'time', title: 'Different time', hint: 'Same meeting, syndicate has another time.' },
  { kind: 'room', title: 'Different room', hint: 'Same meeting and time, syndicate put it in another room.' },
  { kind: 'onlyTheirs', title: 'Only on syndicate’s schedule', hint: 'Syndicate has a meeting we don’t.' },
  { kind: 'onlyOurs', title: 'Only on our schedule', hint: 'We have a meeting syndicate doesn’t.' },
  { kind: 'unknown', title: 'Rows Corda could not read', hint: 'A name that is not an issuer or investor in Corda.' },
];

/**
 * Alex's biggest pain: syndicate allocates the meeting rooms on their own schedule, and the two
 * versions drift. Upload their file and see every difference before the conference starts.
 */
export function SyndicateCompare({ conferenceId, run }: { conferenceId: string; run: Run }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const compare = async (input: { fileName?: string; base64?: string; sample?: boolean }) => {
    setBusy(true);
    await run('syndicateCompare', { conferenceId, ...input }, (r) => {
      const res = r as Result;
      setResult(res);
      return res.differences.length ? `${res.differences.length} differences with syndicate.` : 'Syndicate’s schedule matches ours.';
    });
    setBusy(false);
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    await compare({ fileName: file.name, base64: btoa(bin) });
  };
  const download = () => {
    if (!result?.sampleCsv) return;
    const url = URL.createObjectURL(new Blob([result.sampleCsv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'syndicate-schedule-sample.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="v5-syn">
      <div className="intro">
        <div>
          <h3>Compare with syndicate</h3>
          <p>Upload syndicate’s room schedule (Excel or CSV with Issuer, Investor, Date/Time and Room columns). Corda lists every meeting where the two versions differ. Nothing is changed.</p>
        </div>
        <div className="acts">
          <label className={`v5-btn primary ${busy ? 'disabled' : ''}`}>
            <Upload size={15} /> Upload syndicate file
            <input type="file" accept=".xlsx,.csv,.tsv,.txt" hidden disabled={busy} onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <Button variant="outline" disabled={busy} onClick={() => compare({ sample: true })}>
            <FileSpreadsheet size={15} /> Try a sample file
          </Button>
        </div>
      </div>
      {result && (
        <>
          <div className={`verdict ${result.differences.length ? 'warn' : 'ok'}`}>
            {result.differences.length ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            <span>
              <strong>{result.fileName}</strong>: {result.rows} rows, {result.matched} matched to our {result.ours} meetings ·{' '}
              {result.differences.length ? `${result.differences.length} differences` : 'everything matches'}
            </span>
            {result.sampleCsv && (
              <button className="v5-link" onClick={download}>
                <Download size={13} /> Download the sample
              </button>
            )}
          </div>
          {result.missing.length > 0 && <p className="muted-line">The file has no {result.missing.join(' or ')}; those were not compared.</p>}
          {GROUPS.map((g) => {
            const list = result.differences.filter((d) => d.kind === g.kind);
            if (!list.length) return null;
            return (
              <section key={g.kind} className="group">
                <h4>
                  {g.title} <span>{list.length}</span>
                </h4>
                <p className="hint">{g.hint}</p>
                <div className="rows">
                  {list.map((d, i) => (
                    <div key={i} className="row">
                      {d.kind === 'unknown' ? (
                        <>
                          <strong>Row {d.line}</strong>
                          <span>{d.reason}</span>
                          <span className="muted">{d.raw}</span>
                        </>
                      ) : (
                        <>
                          <strong>
                            {d.issuer} × {d.investor}
                          </strong>
                          {d.kind === 'time' && (
                            <span>
                              Ours <b>{d.ours}</b> · Syndicate <b className="theirs">{d.theirs}</b>
                            </span>
                          )}
                          {d.kind === 'room' && (
                            <span>
                              {d.when} · Ours <b>{d.ours}</b> · Syndicate <b className="theirs">{d.theirs}</b>
                            </span>
                          )}
                          {d.kind === 'onlyTheirs' && (
                            <span>
                              {d.theirs}
                              {d.room ? ` · ${d.room}` : ''}
                            </span>
                          )}
                          {d.kind === 'onlyOurs' && (
                            <span>
                              {d.ours}
                              {d.room ? ` · ${d.room}` : ''}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
