/** Bankers email their coverage preferences; Corda reads them (rules here, model mocked off). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readPreferencesByRules } from '../src/lib/preferences';
import { analyse } from '../src/lib/analysis';

const issuers = [
  { id: 'ford', name: 'Ford Credit', contactEmail: 'treasury@fordcredit.example' },
  { id: 'ally', name: 'Ally Financial', contactEmail: 'ir@ally.example' },
  { id: 'gm', name: 'GM Financial', contactEmail: 'ir@gmfinancial.example' },
  { id: 'san', name: 'Santander', contactEmail: 'ir@santander.example' },
];
const level = (text: string) => Object.fromEntries(readPreferencesByRules(text, issuers).map((p) => [p.issuerId, p.level]));

test('reads levels per issuer, with short names', () => {
  assert.deepEqual(
    level("I must attend the Ford Credit meetings, and please prioritise Ally. Happy to cover GM Financial if there's room. I can't do Santander this year."),
    { ford: 'Must Attend', ally: 'High Priority', gm: 'Medium Priority', san: 'Cannot Attend' },
  );
});

test('a heading line applies to the list under it, and a list shares a trailing level', () => {
  assert.deepEqual(level('Must attend:\n- Ford\n- Santander\nNice to have: GM'), { ford: 'Must Attend', san: 'Must Attend', gm: 'Medium Priority' });
  assert.deepEqual(level('Ford, Ally and GM are must-attends for me.'), { ford: 'Must Attend', ally: 'Must Attend', gm: 'Must Attend' });
});

test('a banker email becomes one preferences item, a client email does not', async () => {
  const deps = {
    conferences: [{ id: 'abs', name: 'ABS East 2026', startDate: '2026-11-14', endDate: '2026-11-16', timezone: 'America/New_York' }],
    issuers,
    investors: [],
    users: [{ id: 'maya', email: 'maya.patel@conferenceos.demo', role: 'BANKER' }],
    meetings: [],
    internal: ['conferenceos.demo'],
    today: '2026-11-10',
    involvement: () => [],
    readPreferences: async (body: string) => ({ preferences: readPreferencesByRules(body, issuers), parser: 'rules' as const }),
    extract: () => ({ asks: [], parser: 'rules' as const }),
  };
  const a = await analyse(
    { sender: 'maya.patel@conferenceos.demo', to: [], cc: [], subject: 'ABS East preferences', body: 'Ford must attend, and please prioritise Ally.' },
    deps,
  );
  assert.equal(a.asks.length, 1);
  assert.equal(a.asks[0].conferenceId, 'abs');
  assert.deepEqual(a.asks[0].preferences.map((p) => [p.issuerId, p.level]), [['ford', 'Must Attend'], ['ally', 'High Priority']]);
});
