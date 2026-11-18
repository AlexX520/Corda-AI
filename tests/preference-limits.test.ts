import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preferenceLimitError, preferenceUsage } from '../src/lib/preference-limits';

test('preference caps: at most 2 must attend and 3 high priority per event', () => {
  assert.equal(preferenceLimitError(['Must Attend', 'Must Attend', 'High Priority', 'High Priority', 'High Priority', 'Medium Priority', 'Cannot Attend']), null);
  assert.match(preferenceLimitError(['Must Attend', 'Must Attend', 'Must Attend']) || '', /At most 2 must per event \(3 chosen\)/);
  assert.match(preferenceLimitError(['High Priority', 'High Priority', 'High Priority', 'High Priority']) || '', /At most 3 high per event/);
  assert.equal(preferenceUsage(['Must Attend', 'High Priority']), 'Must 1/2 · High 1/3');
});
