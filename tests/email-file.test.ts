import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEmailFile } from '../src/lib/email-file';

test('parses a dragged Outlook EML into the inbox ingestion shape', async () => {
  const source = [
    'From: Rachel <ir@bayview.example>',
    'To: Alex Morgan <alex.morgan@corda-ai.demo>',
    'Cc: Sarah Chen <sarah.chen@corda-ai.demo>',
    'Subject: ABS East 2026 - Bayview availability',
    'Message-ID: <bayview-outlook-sample@example>',
    'Thread-Index: AcSampleThread123',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Bayview is available Monday between 3 PM and 5 PM for ABS East 2026.',
  ].join('\r\n');
  const parsed = await parseEmailFile('bayview.eml', new TextEncoder().encode(source));
  assert.equal(parsed.sender, 'ir@bayview.example');
  assert.deepEqual(parsed.to, ['alex.morgan@corda-ai.demo']);
  assert.deepEqual(parsed.cc, ['sarah.chen@corda-ai.demo']);
  assert.equal(parsed.messageId, '<bayview-outlook-sample@example>');
  assert.match(parsed.threadId, /^outlook-thread-/);
  assert.match(parsed.body, /Monday between 3 PM and 5 PM/);
});

test('rejects files that are not supported email formats', async () => {
  await assert.rejects(
    () => parseEmailFile('message.txt', new TextEncoder().encode('hello')),
    /Supported Outlook formats/,
  );
});
