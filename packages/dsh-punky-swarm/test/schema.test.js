import test from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../lib/schema.js';

test('member transitions follow the canonical chain', () => {
  assert.equal(schema.canTransitionMember('pending', 'running'), true);
  assert.equal(schema.canTransitionMember('running', 'review'), true);
  assert.equal(schema.canTransitionMember('review', 'merged'), true);
  assert.equal(schema.canTransitionMember('review', 'conflict'), true);
  assert.equal(schema.canTransitionMember('review', 'failed'), true);
  assert.equal(schema.canTransitionMember('running', 'failed'), true);
  assert.equal(schema.canTransitionMember('running', 'skipped'), true);
  assert.equal(schema.canTransitionMember('idle', 'running'), true);
});

test('member transitions reject illegal moves', () => {
  assert.equal(schema.canTransitionMember('pending', 'merged'), false);
  assert.equal(schema.canTransitionMember('merged', 'running'), false);
  assert.equal(schema.canTransitionMember('conflict', 'merged'), false);
  assert.equal(schema.canTransitionMember('failed', 'running'), false);
  assert.equal(schema.canTransitionMember('skipped', 'review'), false);
  assert.equal(schema.canTransitionMember('unknown', 'running'), false);
});

test('batch phases follow the canonical chain', () => {
  assert.equal(schema.canTransitionBatch('planning', 'running'), true);
  assert.equal(schema.canTransitionBatch('running', 'paused'), true);
  assert.equal(schema.canTransitionBatch('paused', 'running'), true);
  assert.equal(schema.canTransitionBatch('running', 'complete'), true);
  assert.equal(schema.canTransitionBatch('running', 'aborted'), true);
  assert.equal(schema.canTransitionBatch('complete', 'running'), false);
  assert.equal(schema.canTransitionBatch('aborted', 'paused'), false);
});

test('terminal helpers', () => {
  assert.equal(schema.isMemberTerminal('merged'), true);
  assert.equal(schema.isMemberTerminal('failed'), true);
  assert.equal(schema.isMemberTerminal('skipped'), true);
  assert.equal(schema.isMemberTerminal('conflict'), true);
  assert.equal(schema.isMemberTerminal('running'), false);
  assert.equal(schema.isBatchTerminal('complete'), true);
  assert.equal(schema.isBatchTerminal('aborted'), true);
  assert.equal(schema.isBatchTerminal('running'), false);
});

test('assert helpers throw on invalid', () => {
  assert.throws(() => schema.assertMemberTransition('pending', 'merged'));
  assert.throws(() => schema.assertBatchTransition('complete', 'running'));
  assert.throws(() => schema.assertMemberState('bogus'));
  assert.throws(() => schema.assertBatchPhase('bogus'));
});
