/** Only coordinators and managers act on the schedule; extra sender addresses count as the company. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { canOperate, SELF_SERVICE_COMMANDS } from '../src/lib/roles';
import { senderTrust } from '../src/lib/email-trust';

test('coordinators and managers operate; other bankers and sales do not', () => {
  assert.equal(canOperate({ role: 'BANKER', coordinator: true }), true);
  assert.equal(canOperate({ role: 'MANAGER' }), true);
  assert.equal(canOperate({ role: 'BANKER', coordinator: false }), false);
  assert.equal(canOperate({ role: 'SALES' }), false);
  assert.ok(SELF_SERVICE_COMMANDS.has('saveCoveragePreferences'));
  assert.ok(!SELF_SERVICE_COMMANDS.has('review'));
});

test('an exact extra address is verified as that company; the rest of its domain is not', () => {
  const parties = {
    issuers: [{ id: 'ford', name: 'Ford Credit', contactEmail: 'treasury@fordcredit.example', extraContacts: ['tao.test@virginia.edu'] }],
    investors: [{ id: 'pimco', name: 'PIMCO', contactEmail: 'meetings@pimco.example' }],
    internal: ['conferenceos.demo'],
  };
  const ok = senderTrust('Tao.Test@virginia.edu', parties);
  assert.equal(ok.status, 'verified');
  assert.equal(ok.issuerId, 'ford');
  assert.notEqual(senderTrust('someone.else@virginia.edu', parties).status, 'verified');
});
