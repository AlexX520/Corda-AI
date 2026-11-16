/** Syndicate's room schedule vs ours: every difference is listed, names and times read loosely. */
import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { compareSchedules, parseCsv, readTable, type Cell } from '../src/lib/syndicate';

const zone = 'America/New_York';
const issuers = [{ id: 'ford', name: 'Ford Credit' }, { id: 'ally', name: 'Ally Financial' }];
const investors = [{ id: 'pimco', name: 'PIMCO' }, { id: 'nuveen', name: 'Nuveen' }, { id: 'fid', name: 'Fidelity' }];
const ours = [
  { id: 'm1', issuerId: 'ford', investorId: 'pimco', start: '2026-11-16T14:00:00.000Z', room: 'Room 1' }, // 9:00 AM ET
  { id: 'm2', issuerId: 'ally', investorId: 'nuveen', start: '2026-11-16T15:00:00.000Z', room: 'Room 2' },
  { id: 'm3', issuerId: 'ally', investorId: 'pimco', start: '2026-11-16T16:00:00.000Z', room: 'Room 3' },
];

test('CSV: time, room, only-theirs, only-ours and unknown names', () => {
  const csv = 'Date,Time,Issuer,Investor,Room\n11/16/2026,9:00 AM,Ford,PIMCO,Room 1\n2026-11-16,10:30 AM,ALLY FINANCIAL,Nuveen,Cube 2\nNov 16,2:00 PM,Ford Credit,Fidelity,Room 4\nNov 16,3:00 PM,Acme,PIMCO,Room 1';
  const { rows } = readTable(parseCsv(csv), zone, '2026-11-16');
  const r = compareSchedules(rows, ours, issuers, investors, zone);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.differences.map((d) => d.kind).sort(), ['onlyOurs', 'onlyTheirs', 'time', 'unknown']);
});

test('Excel dates and times are read as the conference wall clock', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Schedule');
  ws.addRow(['Syndicate schedule — ABS East']);
  ws.addRow(['Issuer', 'Investor', 'Start', 'Meeting room']);
  ws.addRow(['Ford Credit', 'PIMCO', new Date(Date.UTC(2026, 10, 16, 9, 0)), 'Room 3']);
  const back = new ExcelJS.Workbook();
  await back.xlsx.load((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const table: Cell[][] = [];
  back.worksheets[0].eachRow((row) => table.push((row.values as Cell[]).slice(1)));
  const { rows } = readTable(table, zone, '2026-11-16');
  const r = compareSchedules(rows, ours.slice(0, 1), issuers, investors, zone);
  assert.equal(r.matched, 1);
  assert.deepEqual(r.differences.map((d) => d.kind), ['room']);
});
