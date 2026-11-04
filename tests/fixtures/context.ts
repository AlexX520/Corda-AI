/** Shared in-memory conference data for parser/analysis tests (mirrors the seed, fixed dates). */
import { mockExtractAsks } from '../../src/lib/extraction';
import { analyse } from '../../src/lib/analysis';
const party = (rows: string[][], who: string) =>
  rows.map(([id, name, domain]) => ({ id, name, contactEmail: `${who}@${domain}` }));
export const ctx = {
  conferences: [
    { id: 'abs-east', name: 'ABS East 2026', startDate: '2026-10-19', endDate: '2026-10-21', timezone: 'America/New_York' },
    { id: 'sf-vegas', name: 'Structured Finance Summit', startDate: '2026-11-02', endDate: '2026-11-04', timezone: 'America/Los_Angeles' },
  ],
  issuers: party(
    [
      ['bayview', 'Bayview', 'bayview.example'],
      ['ford', 'Ford Credit', 'fordcredit.example'],
      ['santander', 'Santander', 'santander.example'],
      ['athene', 'Athene', 'athene.example'],
      ['onemain', 'OneMain Financial', 'onemain.example'],
      ['penny', 'PennyMac', 'pennymac.example'],
      ['ally', 'Ally Financial', 'ally.example'],
      ['capital-one', 'Capital One', 'capitalone.example'],
      ['gmf', 'GM Financial', 'gmfinancial.example'],
      ['newrez', 'NewRez', 'newrez.example'],
      ['rocket', 'Rocket Mortgage', 'rocket.example'],
      ['discover', 'Discover', 'discover.example'],
    ],
    'ir',
  ),
  investors: party(
    [
      ['pimco', 'PIMCO', 'pimco.example'],
      ['blackrock', 'BlackRock', 'blackrock.example'],
      ['wellington', 'Wellington Management', 'wellington.example'],
      ['fidelity', 'Fidelity', 'fidelity.example'],
      ['apollo', 'Apollo', 'apollo.example'],
      ['ford-investor', 'Ford Credit', 'fordcredit.example'],
      ['metlife', 'MetLife', 'metlife.example'],
      ['prudential', 'Prudential', 'prudential.example'],
      ['pgim', 'PGIM', 'pgim.example'],
      ['vanguard', 'Vanguard', 'vanguard.example'],
      ['ares', 'Ares Management', 'ares.example'],
      ['kkr', 'KKR', 'kkr.example'],
      ['nuveen', 'Nuveen', 'nuveen.example'],
      ['trowe', 'T. Rowe Price', 'trowe.example'],
      ['invesco', 'Invesco', 'invesco.example'],
    ],
    'meetings',
  ),
};
const T = (day: string, hhmm: string) => new Date(`2026-10-${day}T${hhmm}:00-04:00`).toISOString();
/** The seeded ABS East meetings: [issuer, investor, day, start]. */
const seeded: [string, string, string, string][] = [
  ['bayview', 'pimco', '19', '15:00'], ['ford', 'blackrock', '19', '10:00'], ['santander', 'wellington', '19', '11:00'],
  ['athene', 'apollo', '19', '14:00'], ['onemain', 'apollo', '20', '10:00'], ['bayview', 'wellington', '20', '11:00'],
  ['ford', 'pimco', '20', '13:00'], ['ally', 'metlife', '19', '10:00'], ['capital-one', 'prudential', '19', '10:00'],
  ['gmf', 'pgim', '19', '10:00'], ['newrez', 'vanguard', '19', '10:00'], ['rocket', 'ares', '19', '10:00'],
  ['discover', 'kkr', '19', '10:00'], ['penny', 'nuveen', '19', '11:30'], ['ally', 'trowe', '19', '13:00'],
  ['capital-one', 'invesco', '19', '13:30'], ['gmf', 'fidelity', '19', '15:00'], ['newrez', 'blackrock', '20', '09:30'],
  ['rocket', 'pimco', '20', '10:00'], ['discover', 'wellington', '20', '10:30'], ['penny', 'metlife', '20', '11:00'],
  ['santander', 'prudential', '20', '13:00'], ['athene', 'pgim', '20', '14:00'], ['onemain', 'vanguard', '21', '09:30'],
  ['bayview', 'ares', '21', '10:30'],
];
export const meetings = seeded.map(([issuerId, investorId, day, hhmm], i) => ({
  id: `seed-meeting-${i}`,
  conferenceId: 'abs-east',
  issuerId,
  investorId,
  start: T(day, hhmm),
  end: new Date(+new Date(T(day, hhmm)) + 30 * 60000).toISOString(),
  status: 'Confirmed',
}));
export const internal = ['conferenceos.demo'];
export const users = [
  { id: 'banker-alex', email: 'alex.morgan@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-sarah', email: 'sarah.chen@conferenceos.demo', role: 'BANKER' },
  { id: 'banker-michael', email: 'michael.torres@conferenceos.demo', role: 'BANKER' },
  { id: 'sales-james', email: 'james.wilson@conferenceos.demo', role: 'SALES' },
  { id: 'sales-emma', email: 'emma.davis@conferenceos.demo', role: 'SALES' },
];
export type TestEmail = { sender: string; to: string[]; cc: string[]; subject: string; body: string };
/** Run the ingest analysis (rule parser) on an email, as the service does. */
export function readEmail(e: TestEmail, data = meetings) {
  return analyse(
    { ...e, receivedAt: '2026-10-19T12:00:00Z' },
    {
      ...ctx,
      users,
      meetings: data,
      internal,
      today: '2026-10-19',
      involvement: () => ['abs-east'],
      extract: (body: string, subject: string, c: Parameters<typeof mockExtractAsks>[2], hints: Parameters<typeof mockExtractAsks>[3]) => ({
        ...mockExtractAsks(body, subject, c, hints),
        parser: 'rules' as const,
      }),
    },
  );
}
