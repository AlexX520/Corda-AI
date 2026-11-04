import test from 'node:test';
import assert from 'node:assert/strict';
import { isManualLocation } from '../src/lib/resource-service';

const cubes = ['Meeting Cube 1 · Ocean Tower · Level 2', 'Ocean Tower · Level 2'];

test('approval may fill empty, TBD or cube-derived locations', () => {
  assert.equal(isManualLocation('', cubes), false);
  assert.equal(isManualLocation('TBD', cubes), false);
  assert.equal(isManualLocation('Meeting Cube 1 · Ocean Tower · Level 2', cubes), false);
  assert.equal(isManualLocation('Ocean Tower · Level 2', cubes), false);
});

test('approval never overwrites a location a person typed', () => {
  assert.equal(isManualLocation('Tresor · 103', cubes), true);
  assert.equal(isManualLocation('Issuer suite 1201', cubes), true);
});
