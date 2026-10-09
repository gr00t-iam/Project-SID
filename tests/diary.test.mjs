import test from 'node:test';
import assert from 'node:assert/strict';
import {cleanDiaryText} from '../agent-core/town.mjs';

test('plain diary text passes through unchanged',()=>{
  assert.equal(cleanDiaryText('Dawn over the plateau. I felt calm.'),'Dawn over the plateau. I felt calm.');
});
test('JSON answers yield the entry under any known key',()=>{
  assert.equal(cleanDiaryText('{ "diary_entry": "Dawn over the plateau..." }'),'Dawn over the plateau...');
  assert.equal(cleanDiaryText('{"entry":"Fished all day."}'),'Fished all day.');
  assert.equal(cleanDiaryText('{"text":"Met \\"Ada\\" at the well."}'),'Met "Ada" at the well.');
});
test('code fences and truncated JSON are tolerated',()=>{
  assert.equal(cleanDiaryText('```json\n{"diary_entry":"Built the wall."}\n```'),'Built the wall.');
  assert.equal(cleanDiaryText('{ "diary_entry": "Dawn over the plateau, and I was tir'),'Dawn over the plateau, and I was tir');
});
test('a leading "Day N." prefix is stripped, inside or outside JSON',()=>{
  assert.equal(cleanDiaryText('Day 154. The harvest was good.'),'The harvest was good.');
  assert.equal(cleanDiaryText('{"diary_entry":"Day 12: Rain again."}'),'Rain again.');
  assert.equal(cleanDiaryText('Daylight came early.'),'Daylight came early.');
});
test('unrecognised JSON and empty input fall back safely',()=>{
  assert.equal(cleanDiaryText('{"mood":"ok"}'),'{"mood":"ok"}');
  assert.equal(cleanDiaryText(null),'');
});
