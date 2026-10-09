/* UI and shared clock. The video is the clock while playing inside its range. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id), video = $('video');
  let data = null, scene = null, time = 0, index = -1, playing = false, lastTick = 0;
  let videoReady = false, videoURL = null, offset = 0, loadController = null;
  let page = 0, renderedPage = -1, selectedSecond = -1, detailIndex = -1, lastUI = 0;
  let videoStarting = false, videoBlocked = false, rawToken = 0;
  const pageSize = 12;
  const format = n => Number.isFinite(n) ? n.toFixed(4) : '—';
  const xyz = p => p ? p.slice(0, 3).map(format).join(' / ') : '—';
  function clock(t) {
    const ms = Math.round(Math.max(0, t) * 1000);
    return `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }
  function lamp(active) {
    return `<span class="lamp ${active === 1 ? 'on' : active === 0 ? 'off' : ''}">${active === 1 ? 'Активна' : active === 0 ? 'Неактивна' : 'Нет данных'}</span>`;
  }
  function fail(message) { $('error').textContent = message; $('error').hidden = false; }
  function clearError() { $('error').hidden = true; }
  try { scene = new MotionScene($('scene')); }
  catch (error) {
    $('scene-empty').textContent = '3D недоступно. Включите аппаратное ускорение браузера. Видео и таблица работают.';
    console.warn(error);
  }
  function enableLoaded() {
    for (const id of ['play', 'prev', 'next', 'timeline', 'offset', 'auto-offset', 'export']) $(id).disabled = !data;
  }
  $('tracking-file').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    setPlaying(false); loadController?.abort();
    const controller = new AbortController(); loadController = controller;
    $('load-box').hidden = false; clearError();
    $('message').textContent = 'Чтение файла порциями. Исходные данные остаются на вашем компьютере.';
    $('tracking-name').textContent = `${file.name} · ${(file.size / 1048576).toFixed(1)} МБ`;
    try {
      const loaded = await Tracking.read(file, (fraction, count) => {
        $('progress').value = fraction; $('load-text').textContent = `${Math.round(fraction * 100)}% · ${count.toLocaleString('ru')} кадров`;
      }, controller.signal);
      if (loadController !== controller || controller.signal.aborted) return;
      data = loaded; time = 0; index = -1; renderedPage = -1; selectedSecond = -1; page = 0; detailIndex = -1;
      rawToken++; $('raw').hidden = true; $('raw').textContent = '';
      offset = data.videoOffset; $('offset').value = offset.toFixed(6);
      $('timeline').max = data.duration; $('total').textContent = clock(data.duration);
      $('duration-stat').textContent = clock(data.duration);
      $('frames-stat').textContent = `${data.frames.length.toLocaleString('ru')} / ${data.fps.toFixed(1)} Гц`;
      for (const side of ['left', 'right']) {
        const active = data.frames.filter(f => f[side].active === 1).length;
        $(side + '-stat').textContent = `${(active / data.frames.length * 100).toFixed(2)}%`;
      }
      const d = data.diagnostics;
      $('diagnostics').textContent = `Диагностика: ошибок JSON ${d.badJSON}; неверных меток времени ${d.invalidTime}; дубликатов ${d.duplicates}; кадров с обратным временем ${d.outOfOrder}; неразобранных поз ${d.invalidPoses}; кадров без позы головы ${d.missingHead}. Интервал между кадрами: медиана ${(data.medianDt * 1000).toFixed(2)} мс. Длинных интервалов (>50 мс и >3 медиан): ${data.gapCount}. Кадров с Body: ${d.bodyFrames}.`;
      $('metadata').textContent = JSON.stringify(data.metadata, null, 2);
      const issues = d.badJSON + d.invalidTime + d.duplicates + d.outOfOrder + d.invalidPoses + d.missingHead;
      $('message').textContent = `Запись загружена. ${data.hasVideoAnchor ? 'Сдвиг видео вычислен по метке первого изображения.' : 'Метка первого изображения отсутствует: сдвиг видео установлен в 0.'} ${issues ? 'Есть пропущенные или неполные данные — см. диагностику.' : 'Ошибок чтения не обнаружено.'}`;
      scene?.setData(data); if (scene) $('scene-empty').hidden = true;
      enableLoaded(); setTime(0); buildChart();
    } catch (error) {
      if (loadController !== controller) return;
      if (error.name !== 'AbortError') fail(error.message);
      $('message').textContent = data ? 'Предыдущая запись сохранена в просмотрщике.' : 'Выберите файл трекинга.';
    } finally {
      if (loadController === controller) { $('load-box').hidden = true; loadController = null; }
    }
  });
  $('cancel-load').onclick = () => loadController?.abort();
  $('video-file').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    setPlaying(false); videoReady = false; videoBlocked = false; videoStarting = false; clearError();
    if (videoURL) URL.revokeObjectURL(videoURL);
    videoURL = URL.createObjectURL(file); video.src = videoURL;
    $('video-name').textContent = file.name; $('video-empty').hidden = true;
    $('video-info').textContent = 'Чтение видео…';
  });
  video.addEventListener('loadedmetadata', () => {
    videoReady = Number.isFinite(video.duration) && video.duration > 0;
    $('video-info').textContent = `${video.videoWidth} × ${video.videoHeight} · ${clock(video.duration)}`;
    syncVideo(true);
  });
  video.addEventListener('error', () => {
    videoReady = false; setPlaying(false); $('video-info').textContent = 'Не удалось прочитать видео';
    fail('Браузер не смог открыть видео. Попробуйте MP4 с кодеком H.264. Трекинг можно просматривать отдельно.');
  });
  function inVideoRange(t) { return videoReady && t + offset >= 0 && t + offset < video.duration; }
  function syncVideo(force = false) {
    if (!videoReady) return;
    const target = time + offset, inside = inVideoRange(time);
    $('video-outside').hidden = inside;
    $('video-state').textContent = inside ? 'Общая шкала времени' : 'За пределами видео';
    if (force && Math.abs(video.currentTime - Math.max(0, Math.min(video.duration, target))) > .001) {
      video.currentTime = Math.max(0, Math.min(video.duration, target));
    }
    if (playing && inside && !videoBlocked) {
      if (video.paused && !videoStarting) {
        // On entering a clip after a tracking-only interval, seek before playing.
        if (Math.abs(video.currentTime - target) > .05) video.currentTime = target;
        videoStarting = true;
        video.play().then(() => {
          videoStarting = false;
          if (!playing) video.pause();
        }).catch(error => {
          videoStarting = false;
          if (error.name === 'AbortError') return;
          videoBlocked = true; setPlaying(false);
          fail('Не удалось начать видео. Нажмите «Воспроизвести» ещё раз или выберите поддерживаемый файл.');
        });
      }
    } else if (!video.paused) video.pause();
  }
  function setPlaying(value) {
    playing = value && !!data;
    $('play').textContent = playing ? 'Ⅱ Пауза' : '▶ Воспроизвести';
    lastTick = performance.now(); syncVideo();
    if (!playing) { video.pause(); updateUI(true); }
  }
  function setTime(t) {
    if (!data) return;
    time = Math.max(0, Math.min(data.duration, t));
    index = Tracking.nearest(data.frames, time);
    syncVideo(true); scene?.update(index); updateUI(true);
  }
  $('play').onclick = () => {
    videoBlocked = false;
    if (!playing && time >= data.duration) setTime(0);
    setPlaying(!playing);
  };
  $('timeline').oninput = e => { const target = Number(e.target.value); setPlaying(false); setTime(target); };
  $('prev').onclick = () => { setPlaying(false); setTime(data.frames[Math.max(0, index - 1)].t); };
  $('next').onclick = () => { setPlaying(false); setTime(data.frames[Math.min(data.frames.length - 1, index + 1)].t); };
  $('speed').onchange = () => { video.playbackRate = Number($('speed').value); lastTick = performance.now(); };
  $('offset').onchange = e => {
    const v = Number(e.target.value); if (!Number.isFinite(v)) return;
    offset = v; syncVideo(true);
  };
  $('auto-offset').onclick = () => { offset = data.videoOffset; $('offset').value = offset.toFixed(6); syncVideo(true); };
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => scene?.view(button.dataset.view));
  $('trails').onchange = e => { if (scene) { scene.showTrails = e.target.checked; if (data) scene.update(index); } };

  function updateUI(force = false) {
    if (!data || index < 0) return;
    const now = performance.now(); if (!force && now - lastUI < 85) return; lastUI = now;
    const f = data.frames[index];
    $('clock').textContent = clock(time); $('timeline').value = time;
    $('frame-info').textContent = `Кадр ${(index + 1).toLocaleString('ru')} / ${data.frames.length.toLocaleString('ru')} · точное время ${clock(f.t)}`;
    $('live-status').innerHTML = `<span>Левая: ${lamp(f.left.active)}</span><span>Правая: ${lamp(f.right.active)}</span>`;
    const second = Math.floor(time);
    if ($('follow').checked) page = Math.floor(second / pageSize);
    if (page !== renderedPage) renderTable();
    if (second !== selectedSecond) {
      document.querySelectorAll('#rows tr').forEach(row => row.classList.toggle('selected', Number(row.dataset.second) === second));
      selectedSecond = second;
    }
    renderDetails(); drawChart();
  }
  function renderTable() {
    if (!data) return;
    const buckets = data.buckets.slice(page * pageSize, (page + 1) * pageSize);
    $('rows').innerHTML = buckets.map(b => {
      const f = data.frames[b.index];
      return `<tr data-second="${b.second}"><td><button data-seek="${b.second}" aria-label="Перейти к ${b.second} секунде">${clock(b.second).slice(0, 5)}<small>${clock(f.t)} · №${b.index + 1}</small></button></td><td class="coords">${xyz(f.head)}</td><td class="coords">${xyz(Tracking.wrist(f.left))}</td><td>${lamp(f.left.active)}</td><td class="coords">${xyz(Tracking.wrist(f.right))}</td><td>${lamp(f.right.active)}</td><td>${b.count ? `${b.inactiveLeft} / ${b.inactiveRight} из ${b.count}` : 'Нет кадров'}</td></tr>`;
    }).join('');
    renderedPage = page; selectedSecond = -1;
    $('page-info').textContent = `${page + 1} / ${Math.ceil(data.buckets.length / pageSize)} · ${data.buckets.length} строк`;
    $('page-prev').disabled = page === 0;
    $('page-next').disabled = (page + 1) * pageSize >= data.buckets.length;
  }
  $('rows').onclick = e => {
    const button = e.target.closest('[data-seek]'); if (!button) return;
    setPlaying(false); setTime(Number(button.dataset.seek));
  };
  $('page-prev').onclick = () => { $('follow').checked = false; page = Math.max(0, page - 1); renderTable(); updateUI(true); };
  $('page-next').onclick = () => { $('follow').checked = false; page++; renderTable(); updateUI(true); };
  $('follow').onchange = () => updateUI(true);
  $('details').ontoggle = () => renderDetails();
  function renderDetails() {
    if (!data || index < 0 || !$('details').open || detailIndex === index) return;
    detailIndex = index; const f = data.frames[index];
    $('detail-meta').textContent = `Кадр ${index + 1}, ${clock(f.t)}. timeStampNs: ${f.stamp}. Head.status: ${f.headStatus}. Фокус приложения: ${f.focus}. Input: ${f.input}.`;
    $('head-detail').textContent = `Голова X / Y / Z: ${xyz(f.head)} м. Кватернион x / y / z / w: ${f.head ? f.head.slice(3).map(format).join(' / ') : '—'}.`;
    $('joint-rows').innerHTML = Tracking.JOINTS.map((name, j) => `<tr><td>${j}. ${name}</td><td class="coords">${Tracking.validJoint(f.left, j) ? xyz(Array.from(f.left.poses.subarray(j * 7, j * 7 + 3))) : '—'}</td><td>${f.left.flags[j]}</td><td class="coords">${Tracking.validJoint(f.right, j) ? xyz(Array.from(f.right.poses.subarray(j * 7, j * 7 + 3))) : '—'}</td><td>${f.right.flags[j]}</td></tr>`).join('');
    rawToken++; $('raw').hidden = true;
  }
  $('raw-button').onclick = async () => {
    if (!data) return;
    setPlaying(false); const token = ++rawToken, frame = data.frames[index], file = data.file;
    try {
      const text = await file.slice(frame.source.offset, frame.source.offset + frame.source.length).text();
      if (token !== rawToken) return;
      $('raw').textContent = JSON.stringify(Tracking.parseJSON(text), null, 2); $('raw').hidden = false;
    } catch (_) { fail('Не удалось прочитать исходный кадр. Выберите файл повторно.'); }
  };

  let chartCache = null, chartRange = [-1, 1];
  function buildChart() {
    if (!data) return;
    const values = [];
    for (const f of data.frames) {
      if (f.head) values.push(f.head[1]);
      for (const side of ['left', 'right']) { const w = Tracking.wrist(f[side]); if (w) values.push(w[1]); }
    }
    let min = Infinity, max = -Infinity;
    for (const v of values) { min = Math.min(min, v); max = Math.max(max, v); }
    if (!Number.isFinite(min)) { min = -1; max = 1; }
    const pad = Math.max(.05, (max - min) * .1); chartRange = [min - pad, max + pad];
    chartCache = null; drawChart();
  }
  function drawChart() {
    const canvas = $('chart'), width = canvas.clientWidth, height = 150, ratio = Math.min(devicePixelRatio, 2);
    if (width < 1) return;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== height * ratio) {
      canvas.width = Math.round(width * ratio); canvas.height = height * ratio; chartCache = null;
    }
    const ctx = canvas.getContext('2d');
    if (!chartCache) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
      ctx.font = '11px Segoe UI'; ctx.lineWidth = 1;
      const [min, max] = chartRange;
      for (let j = 0; j < 4; j++) {
        const y = 15 + j * 32; ctx.strokeStyle = '#303943'; ctx.beginPath(); ctx.moveTo(54, y); ctx.lineTo(width - 20, y); ctx.stroke();
        ctx.fillStyle = '#a0afbc'; ctx.fillText((max - (max - min) * (y - 15) / 96).toFixed(2), 10, y + 4);
      }
      ctx.fillStyle = '#a0afbc'; ctx.fillText('0 с', 54, 140);
      if (data) {
        ctx.textAlign = 'right'; ctx.fillText(`${data.duration.toFixed(1)} с`, width - 20, 140); ctx.textAlign = 'left';
        for (const [side, color] of [['head', '#b6a2ff'], ['left', '#69d5ff'], ['right', '#ffaf68']]) {
          ctx.strokeStyle = color; ctx.lineWidth = 1.25; ctx.beginPath(); let open = false, prev = -Infinity;
          for (const f of data.frames) {
            const p = side === 'head' ? f.head : Tracking.wrist(f[side]);
            if (!p) { open = false; continue; }
            const x = 54 + f.t / (data.duration || 1) * (width - 74), y = 15 + (max - p[1]) / (max - min) * 96;
            if (!open || f.t - prev > .08) ctx.moveTo(x, y); else ctx.lineTo(x, y);
            open = true; prev = f.t;
          }
          ctx.stroke();
        }
      }
      chartCache = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } else ctx.putImageData(chartCache, 0, 0);
    if (data) {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      const x = 54 + time / (data.duration || 1) * (width - 74);
      ctx.strokeStyle = '#c5f078'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 8); ctx.lineTo(x, 119); ctx.stroke();
    }
  }
  new ResizeObserver(() => { chartCache = null; drawChart(); }).observe($('chart'));
  $('chart').onclick = e => {
    if (!data) return;
    const r = e.currentTarget.getBoundingClientRect(); setPlaying(false);
    setTime((e.clientX - r.left - 54) / (r.width - 74) * data.duration);
  };
  $('export').onclick = () => {
    if (!data) return;
    const lines = [['second', 'sample_time_s', 'frame', 'head_x_m', 'head_y_m', 'head_z_m',
      'left_wrist_x_m', 'left_wrist_y_m', 'left_wrist_z_m', 'left_active',
      'right_wrist_x_m', 'right_wrist_y_m', 'right_wrist_z_m', 'right_active',
      'inactive_left_frames', 'inactive_right_frames', 'frames_in_second'].join(',')];
    for (const b of data.buckets) {
      const f = data.frames[b.index];
      lines.push([b.second, f.t.toFixed(9), b.index + 1, ...(f.head?.slice(0, 3) || ['', '', '']),
        ...(Tracking.wrist(f.left) || ['', '', '']), f.left.active,
        ...(Tracking.wrist(f.right) || ['', '', '']), f.right.active,
        b.inactiveLeft, b.inactiveRight, b.count].join(','));
    }
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type:'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'tracking-per-second.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  function tick(now) {
    if (playing && data) {
      const dt = Math.min(.15, (now - lastTick) / 1000) * Number($('speed').value);
      if (inVideoRange(time) && !videoBlocked && !video.ended) {
        // Freeze alongside buffering/seeking; never run the skeleton ahead of a stalled video.
        if (!video.seeking && !video.paused && video.readyState >= 2) time = Math.max(0, video.currentTime - offset);
      } else time += dt;
      if (time >= data.duration) { time = data.duration; setPlaying(false); }
      const newIndex = Tracking.nearest(data.frames, time);
      if (newIndex !== index) { index = newIndex; scene?.update(index); }
      syncVideo(); updateUI();
    }
    lastTick = now; requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  window.addEventListener('pagehide', () => { if (videoURL) URL.revokeObjectURL(videoURL); });
})();
