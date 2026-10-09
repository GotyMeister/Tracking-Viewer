/* XRoboToolkit JSON Lines reader. No network requests; works from file://. */
(function (root) {
  'use strict';
  const JOINTS = ['Ладонь', 'Запястье', 'Большой: пясть', 'Большой: проксимальный',
    'Большой: дистальный', 'Большой: кончик', 'Указательный: пясть',
    'Указательный: проксимальный', 'Указательный: средний', 'Указательный: дистальный',
    'Указательный: кончик', 'Средний: пясть', 'Средний: проксимальный',
    'Средний: средний', 'Средний: дистальный', 'Средний: кончик', 'Безымянный: пясть',
    'Безымянный: проксимальный', 'Безымянный: средний', 'Безымянный: дистальный',
    'Безымянный: кончик', 'Мизинец: пясть', 'Мизинец: проксимальный',
    'Мизинец: средний', 'Мизинец: дистальный', 'Мизинец: кончик'];
  const CHAINS = [[1, 2, 3, 4, 5], [1, 6, 7, 8, 9, 10],
    [1, 11, 12, 13, 14, 15], [1, 16, 17, 18, 19, 20], [1, 21, 22, 23, 24, 25],
    [6, 11, 16, 21], [1, 0, 11]];

  function parsePose(value) {
    let numbers;
    if (Array.isArray(value)) numbers = value.map(Number);
    else if (typeof value === 'string') {
      const parts = value.split(',').map(s => s.trim());
      if (parts.length === 7 && parts.every(s => s !== '')) numbers = parts.map(Number);
      else if (parts.length === 14) {
        numbers = [];
        for (let i = 0; i < 14; i += 2) {
          // The provided recording uses a comma for BOTH decimal and list separators.
          // Accept only the unambiguous seven-pair form. Never guess mixed forms.
          if (!/^[+-]?\d+$/.test(parts[i]) || !/^\d+(?:[eE][+-]?\d+)?$/.test(parts[i + 1])) return null;
          numbers.push(Number(parts[i] + '.' + parts[i + 1]));
        }
      } else return null;
    } else return null;
    if (numbers.length !== 7 || !numbers.every(Number.isFinite)) return null;
    return numbers;
  }

  function parseJSON(line) {
    // Preserve nanoseconds before JSON.parse turns a 19-digit integer into a Number.
    return JSON.parse(line.replace(/("timeStampNs"\s*:\s*)(-?\d+)/g, '$1"$2"'));
  }

  function hand(value, diagnostics) {
    const poses = new Float32Array(26 * 7).fill(NaN);
    const flags = new Uint8Array(26);
    const joints = value?.HandJointLocations || [];
    for (let j = 0; j < Math.min(joints.length, 26); j++) {
      const pose = parsePose(joints[j].p);
      if (pose) poses.set(pose, j * 7);
      else diagnostics.invalidPoses++;
      flags[j] = Number(joints[j].s) || 0;
    }
    return { poses, flags, active: value?.isActive === undefined ? null : Number(value.isActive),
      scale: value?.scale ?? null, count: joints.length };
  }

  function validJoint(h, j) {
    return h.active === 1 && (h.flags[j] & 2) !== 0 &&
      [0, 1, 2].every(k => Number.isFinite(h.poses[j * 7 + k]));
  }
  function wrist(h) { return validJoint(h, 1) ? Array.from(h.poses.subarray(7, 10)) : null; }
  function lowerBound(frames, t) {
    let lo = 0, hi = frames.length;
    while (lo < hi) { const m = (lo + hi) >>> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
    return lo;
  }
  function nearest(frames, t) {
    if (!frames.length) return -1;
    const i = lowerBound(frames, t);
    if (i === 0) return 0;
    if (i === frames.length) return i - 1;
    return t - frames[i - 1].t <= frames[i].t - t ? i - 1 : i;
  }

  async function read(file, onProgress = () => {}, signal) {
    const frames = [], metadata = {};
    const diagnostics = { lines: 0, badJSON: 0, invalidTime: 0, invalidPoses: 0,
      duplicates: 0, outOfOrder: 0, missingHead: 0, bodyFrames: 0 };
    let buffer = '', lineOffset = 0, origin = null, lastStamp = null;
    const decoder = new TextDecoder('utf-8', { ignoreBOM:true }), encoder = new TextEncoder();
    const chunkSize = 1024 * 1024;
    function consume(line) {
      const bytes = encoder.encode(line).length;
      const source = { offset: lineOffset, length: bytes };
      lineOffset += bytes + 1;
      diagnostics.lines++;
      if (!line.trim()) return;
      let obj;
      try { obj = parseJSON(line.replace(/^\uFEFF/, '')); }
      catch (_) { diagnostics.badJSON++; return; }
      if (!obj.Head && !obj.Hand && (obj.notice || obj.cameraIntrinsics || obj.cameraExtrinsics)) {
        Object.assign(metadata, obj); return;
      }
      if (!obj.Head && !obj.Hand) return;
      let stamp;
      try { stamp = BigInt(obj.timeStampNs); }
      catch (_) { diagnostics.invalidTime++; return; }
      if (lastStamp !== null && stamp <= lastStamp) {
        if (stamp === lastStamp) diagnostics.duplicates++;
        else diagnostics.outOfOrder++;
        // Keep file ordering, reject backwards/duplicate records explicitly.
        return;
      }
      if (origin === null) origin = stamp;
      lastStamp = stamp;
      const head = parsePose(obj.Head?.pose);
      if (!head) diagnostics.missingHead++;
      const left = hand(obj.Hand?.leftHand, diagnostics), right = hand(obj.Hand?.rightHand, diagnostics);
      if (obj.Body) diagnostics.bodyFrames++;
      frames.push({ t: Number(stamp - origin) / 1e9, head, headStatus: obj.Head?.status ?? null,
        left, right, source, stamp: String(stamp), focus: obj.appState?.focus ?? null, input: obj.Input ?? null });
    }
    for (let pos = 0; pos < file.size; pos += chunkSize) {
      if (signal?.aborted) throw new DOMException('Загрузка отменена', 'AbortError');
      buffer += decoder.decode(await file.slice(pos, pos + chunkSize).arrayBuffer(), { stream: true });
      let start = 0, end;
      while ((end = buffer.indexOf('\n', start)) !== -1) {
        consume(buffer.slice(start, end)); start = end + 1;
      }
      buffer = buffer.slice(start);
      onProgress(Math.min(1, (pos + chunkSize) / file.size), frames.length);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!frames.length) throw new Error('Не найдены кадры с Head/Hand и timeStampNs. Нужен JSON Lines из XRoboToolkit.');
    const duration = frames.at(-1).t;
    const buckets = Array.from({ length: Math.floor(duration) + 1 }, (_, second) =>
      ({ second, index: nearest(frames, second), count: 0, inactiveLeft: 0, inactiveRight: 0,
        invalidLeft: 0, invalidRight: 0 }));
    for (const f of frames) {
      const b = buckets[Math.floor(f.t)]; b.count++;
      if (f.left.active !== 1) b.inactiveLeft++;
      if (f.right.active !== 1) b.inactiveRight++;
      if (!wrist(f.left)) b.invalidLeft++;
      if (!wrist(f.right)) b.invalidRight++;
    }
    const intervals = frames.slice(1).map((f, i) => f.t - frames[i].t).sort((a, b) => a - b);
    const medianDt = intervals[Math.floor(intervals.length / 2)] || 0;
    let videoOffset = 0, hasVideoAnchor = false;
    try {
      if (metadata.timeStampNs !== undefined) {
        videoOffset = Number(origin - BigInt(metadata.timeStampNs)) / 1e9;
        hasVideoAnchor = true;
      }
    } catch (_) { /* no reliable video anchor */ }
    return { frames, metadata, diagnostics, duration, buckets, medianDt, videoOffset, hasVideoAnchor,
      fps: duration > 0 ? (frames.length - 1) / duration : 0,
      gapCount: intervals.filter(dt => dt > Math.max(0.05, medianDt * 3)).length, file };
  }
  const api = { JOINTS, CHAINS, parsePose, parseJSON, read, nearest, lowerBound, validJoint, wrist };
  if (typeof module !== 'undefined') module.exports = api;
  root.Tracking = api;
})(typeof window !== 'undefined' ? window : globalThis);
