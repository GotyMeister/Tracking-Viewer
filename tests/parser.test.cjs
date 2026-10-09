'use strict';
const assert = require('node:assert/strict');
const P = require('../parser.js');
const pose = '0.1,-0.2,0.3,0,0,0,1';
const joints = Array.from({ length:26 }, () => ({ p:pose, s:15, r:0 }));
const frame = stamp => ({ timeStampNs:String(stamp), Head:{ pose, status:3 },
  Hand:{ leftHand:{ isActive:1, HandJointLocations:joints }, rightHand:{ isActive:0, HandJointLocations:joints } } });
async function main() {
  assert.deepEqual(P.parsePose('-0,08517717,-0,02745685,-0,0058761,0,162562191,-0,2861428,-0,116477557,-0,9370853'),
    [-.08517717, -.02745685, -.0058761, .162562191, -.2861428, -.116477557, -.9370853]);
  assert.deepEqual(P.parsePose(pose), [.1, -.2, .3, 0, 0, 0, 1]);
  assert.equal(P.parsePose('0,2,0,1,0,0,0,1'), null, 'ambiguous mixed comma format is rejected');
  assert.equal(P.parsePose('NaN,0,0,0,0,0,1'), null);
  assert.equal(P.parseJSON('{"timeStampNs":1777989460861108224}').timeStampNs, '1777989460861108224');
  const base = 1777989460861108224n;
  const metadata = '{"notice":"первый кадр", "timeStampNs":1777989460861108224}';
  const a = JSON.stringify(frame(base + 18389760n)), b = JSON.stringify(frame(base + 18389761n));
  const contents = '\uFEFF' + metadata + '\r\n' + a + '\r\n' + b + '\r\n' + b + '\r\nnot-json\r\n';
  const blob = new Blob([contents]); const d = await P.read(blob);
  assert.equal(d.frames.length, 2); assert.equal(d.duration, 1e-9);
  assert.equal(d.videoOffset, .01838976); assert.equal(d.diagnostics.duplicates, 1);
  assert.equal(d.diagnostics.badJSON, 1); assert.equal(d.buckets[0].inactiveRight, 2);
  assert.equal(P.validJoint(d.frames[0].right, 1), false);
  assert.equal(P.validJoint(d.frames[0].left, 1), true);
  const src = d.frames[1].source;
  assert.equal((await blob.slice(src.offset, src.offset + src.length).text()).trim(), b, 'UTF-8 / BOM source offsets');
  assert.equal(P.nearest([{t:0},{t:1},{t:2}], .8), 1);
  assert.equal(P.nearest([{t:0},{t:1},{t:2}], 50), 2);
  const bad = await P.read(new Blob([a + '\n' + JSON.stringify(frame(base))]));
  assert.equal(bad.diagnostics.outOfOrder, 1);
  await assert.rejects(P.read(new Blob(['{}'])), /Не найдены/);
  const c = new AbortController(); c.abort();
  await assert.rejects(P.read(blob, () => {}, c.signal), { name:'AbortError' });
  console.log('PASS: locale poses, exact nanoseconds, UTF-8 offsets, flags, buckets, duplicates, reverse time, cancel/errors.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
