/*
 * Georgian TV — main app logic: channel list, remote control, auto-reconnect.
 */
(function () {
  var $ = function (id) { return document.getElementById(id); };

  var KEY = {
    LEFT: [37], UP: [38], RIGHT: [39], DOWN: [40], ENTER: [13],
    BACK: [10009, 8, 27], CH_UP: [427, 33], CH_DOWN: [428, 34],
    INFO: [457, 73], RED: [403, 82], GREEN: [404, 71], PRECH: [10190, 80],
    CH_LIST: [10073, 76]
  };
  function is(code, name) { return KEY[name].indexOf(code) !== -1; }

  var CONNECT_TIMEOUT = 20000;   // ms to wait for a stream to start
  var STALL_TIMEOUT = 15000;     // ms of buffering before we reconnect
  var MAX_CYCLES = 3;            // how many times to cycle through all URLs before giving up

  var channels = [];
  var cur = -1, prev = -1, focus = 0;
  var urlIdx = 0, sameUrlRetries = 0, cycle = 0;
  var playing = false, watchdog = null, retryTimer = null;
  var osdTimer = null, toastTimer = null, numTimer = null, numBuf = '';
  var backPressedAt = 0;

  /* ---------------- storage (safe) ---------------- */
  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  /* ---------------- UI helpers ---------------- */
  function show(el, on) {
    if (on) el.className = el.className.replace(/\s*hidden/g, '');
    else if (el.className.indexOf('hidden') === -1) el.className += ' hidden';
  }
  function visible(el) { return el.className.indexOf('hidden') === -1; }

  function toast(msg, ms) {
    $('toast').textContent = msg;
    show($('toast'), true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { show($('toast'), false); }, ms || 3500);
  }

  function setState(text, cls) {
    var s = $('osd-state');
    s.textContent = text;
    s.className = cls || '';
  }

  function spinner(on, text) {
    show($('spinner'), on);
    if (text) $('spinner-text').textContent = text;
  }

  function clock() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    $('osd-clock').textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function showOsd(ms) {
    var ch = channels[cur];
    if (!ch) return;
    $('osd-num').textContent = cur + 1;
    $('osd-name').textContent = ch.name;
    $('osd-ka').textContent = ch.ka || '';
    clock();
    show($('osd'), true);
    clearTimeout(osdTimer);
    if (ms !== 0) osdTimer = setTimeout(function () { if (playing) show($('osd'), false); }, ms || 5000);
  }

  /* ---------------- channel list ---------------- */
  function renderList() {
    var ul = $('channels'), html = '';
    for (var i = 0; i < channels.length; i++) {
      var c = channels[i];
      html += '<li data-i="' + i + '"><div class="num">' + (i + 1) + '</div>' +
        '<div class="names"><div class="en">' + esc(c.name) + '</div>' +
        (c.ka ? '<div class="ka">' + esc(c.ka) + '</div>' : '') + '</div>' +
        (i === cur ? '<div class="now">● Live</div>' : '') + '</li>';
    }
    ul.innerHTML = html;
    highlight();
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function highlight() {
    var ul = $('channels'), items = ul.getElementsByTagName('li');
    for (var i = 0; i < items.length; i++) {
      items[i].className = i === focus ? 'focused' : '';
    }
    var it = items[focus];
    if (it) {
      var top = it.offsetTop - ul.clientHeight / 2 + it.offsetHeight / 2;
      ul.scrollTop = Math.max(0, top);
    }
  }

  function openList() {
    focus = cur < 0 ? 0 : cur;
    show($('list'), true);
    renderList();
    show($('osd'), false);
  }
  function closeList() { show($('list'), false); }

  /* ---------------- tuning & auto-reconnect ---------------- */
  function clearTimers() {
    clearTimeout(watchdog); watchdog = null;
    clearTimeout(retryTimer); retryTimer = null;
  }

  function tune(i) {
    if (!channels.length) return;
    i = (i + channels.length) % channels.length;
    if (i !== cur) prev = cur;
    cur = i;
    save('gtv.last', channels[cur].id || channels[cur].name);
    urlIdx = 0; sameUrlRetries = 0; cycle = 0;
    showOsd(0);
    if (visible($('list'))) renderList();
    startStream();
  }

  function startStream() {
    clearTimers();
    playing = false;
    var ch = channels[cur];
    var url = ch.urls[urlIdx];
    var label = ch.urls.length > 1 ? ' (source ' + (urlIdx + 1) + '/' + ch.urls.length + ')' : '';
    spinner(true, 'Connecting…' + label);
    setState('Connecting…' + label);
    armWatchdog(CONNECT_TIMEOUT);
    Player.play(url, {
      onPlaying: onPlaying,
      onBuffering: onBuffering,
      onError: function (msg) { failover(msg); }
    });
  }

  function armWatchdog(ms) {
    if (watchdog) return;
    watchdog = setTimeout(function () {
      watchdog = null;
      if (playing) return;
      // stuck buffering/connecting: retry the same source once, then move on
      if (sameUrlRetries < 1) { sameUrlRetries++; startStream(); }
      else failover('Timed out');
    }, ms);
  }

  function onPlaying() {
    clearTimeout(watchdog); watchdog = null;
    playing = true;
    spinner(false);
    setState('● Live', 'live');
    showOsd(4000);
    // once a stream has run smoothly for a minute, forget earlier failures
    setTimeout(function () { if (playing) { sameUrlRetries = 0; cycle = 0; } }, 60000);
  }

  function onBuffering(pct) {
    if (playing && pct === 0) {
      playing = false;
      armWatchdog(STALL_TIMEOUT);
    }
    if (!playing) {
      var t = pct > 0 && pct < 100 ? 'Buffering ' + pct + '%' : 'Buffering…';
      spinner(true, t);
      setState(t);
    }
  }

  function failover(reason) {
    clearTimers();
    playing = false;
    var ch = channels[cur];
    if (window.console) console.log('[GTV] ' + ch.name + ' source ' + (urlIdx + 1) + ' failed: ' + reason);
    urlIdx++;
    sameUrlRetries = 0;
    if (urlIdx < ch.urls.length) { startStream(); return; }
    urlIdx = 0;
    cycle++;
    if (cycle < MAX_CYCLES) {
      spinner(true, 'Retrying in 5 seconds…');
      setState('Retrying…', 'bad');
      retryTimer = setTimeout(startStream, 5000);
    } else {
      Player.stop();
      spinner(false);
      setState('Not available right now', 'bad');
      showOsd(0);
      toast(ch.name + ' is not available right now. Try another channel, or press the GREEN button to retry.', 7000);
    }
  }

  /* ---------------- playlist loading ---------------- */
  function fetchText(urls, i, done) {
    if (i >= urls.length) { done(null); return; }
    var x = new XMLHttpRequest(), finished = false;
    x.open('GET', urls[i] + (urls[i].indexOf('?') < 0 ? '?t=' : '&t=') + Date.now(), true);
    x.timeout = 10000;
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || finished) return;
      finished = true;
      if (x.status === 200 && x.responseText.indexOf('#EXTM3U') !== -1) done(x.responseText);
      else fetchText(urls, i + 1, done);
    };
    x.ontimeout = function () { if (!finished) { finished = true; fetchText(urls, i + 1, done); } };
    try { x.send(); } catch (e) { finished = true; fetchText(urls, i + 1, done); }
  }

  function applyPlaylist(text) {
    var keepId = cur >= 0 ? (channels[cur].id || channels[cur].name) : load('gtv.last');
    channels = browserFilter(text ? mergeChannels(BUILTIN_CHANNELS, parseM3U(text)) : mergeChannels(BUILTIN_CHANNELS, []));
    var found = -1;
    for (var i = 0; i < channels.length; i++) {
      if ((channels[i].id || channels[i].name) === keepId) found = i;
    }
    return found;
  }

  function refreshPlaylist(manual) {
    $('list-status').textContent = 'Updating channel list…';
    fetchText(PLAYLIST_SOURCES, 0, function (text) {
      if (!text) {
        $('list-status').textContent = channels.length + ' channels · offline list';
        if (manual) toast('Could not update the channel list — using the saved one.');
        return;
      }
      save('gtv.playlist', text);
      save('gtv.updated', String(Date.now()));
      var wasPlaying = cur >= 0 ? channels[cur] : null;
      var idx = applyPlaylist(text);
      if (idx >= 0) cur = idx;
      $('list-status').textContent = channels.length + ' channels · list updated just now';
      if (visible($('list'))) renderList();
      if (manual) toast('Channel list updated: ' + channels.length + ' channels');
      // if the current channel had failed completely, try again with the new addresses
      if (wasPlaying && !playing && cycle >= MAX_CYCLES && idx >= 0) tune(idx);
    });
  }

  /* ---------------- remote control ---------------- */
  function registerKeys() {
    if (typeof tizen === 'undefined' || !tizen.tvinputdevice) return;
    var names = ['ChannelUp', 'ChannelDown', 'Info', 'ColorF0Red', 'ColorF1Green', 'PreviousChannel', 'ChannelList',
      '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    for (var i = 0; i < names.length; i++) {
      try { tizen.tvinputdevice.registerKey(names[i]); } catch (e) {}
    }
    // use the TV's real key codes in case they differ by model
    try {
      KEY.CH_UP.push(tizen.tvinputdevice.getKey('ChannelUp').code);
      KEY.CH_DOWN.push(tizen.tvinputdevice.getKey('ChannelDown').code);
      KEY.INFO.push(tizen.tvinputdevice.getKey('Info').code);
      KEY.PRECH.push(tizen.tvinputdevice.getKey('PreviousChannel').code);
      KEY.CH_LIST.push(tizen.tvinputdevice.getKey('ChannelList').code);
    } catch (e) {}
  }

  function digit(code) {
    if (code >= 48 && code <= 57) return code - 48;
    if (code >= 96 && code <= 105) return code - 96;
    return -1;
  }

  function onDigit(d) {
    numBuf = (numBuf + d).slice(-3);
    $('numentry').textContent = numBuf;
    show($('numentry'), true);
    clearTimeout(numTimer);
    numTimer = setTimeout(function () {
      var n = parseInt(numBuf, 10);
      numBuf = '';
      show($('numentry'), false);
      if (n >= 1 && n <= channels.length) { closeList(); tune(n - 1); }
      else toast('No channel ' + n);
    }, 1500);
  }

  function exitApp() {
    Player.stop();
    try { tizen.application.getCurrentApplication().exit(); } catch (e) { toast('Exit'); }
  }

  function onKey(e) {
    var k = e.keyCode, d = digit(k);
    var listOpen = visible($('list'));

    if (d >= 0) { onDigit(d); e.preventDefault(); return; }

    if (listOpen) {
      if (is(k, 'UP')) { focus = (focus - 1 + channels.length) % channels.length; highlight(); }
      else if (is(k, 'DOWN')) { focus = (focus + 1) % channels.length; highlight(); }
      else if (is(k, 'CH_UP')) { focus = Math.max(0, focus - 7); highlight(); }
      else if (is(k, 'CH_DOWN')) { focus = Math.min(channels.length - 1, focus + 7); highlight(); }
      else if (is(k, 'ENTER')) { closeList(); if (focus !== cur || !playing) tune(focus); else showOsd(); }
      else if (is(k, 'BACK') || is(k, 'LEFT') || is(k, 'RIGHT') || is(k, 'CH_LIST')) closeList();
      else if (is(k, 'RED')) refreshPlaylist(true);
      else return;
    } else {
      if (is(k, 'UP') || is(k, 'CH_UP')) tune(cur + 1);
      else if (is(k, 'DOWN') || is(k, 'CH_DOWN')) tune(cur - 1);
      else if (is(k, 'ENTER') || is(k, 'LEFT') || is(k, 'CH_LIST')) openList();
      else if (is(k, 'INFO') || is(k, 'RIGHT')) showOsd();
      else if (is(k, 'GREEN')) { toast('Reconnecting…', 1500); tune(cur); }
      else if (is(k, 'RED')) refreshPlaylist(true);
      else if (is(k, 'PRECH')) { if (prev >= 0) tune(prev); }
      else if (is(k, 'BACK')) {
        var now = Date.now();
        if (now - backPressedAt < 2500) exitApp();
        else { backPressedAt = now; toast('Press BACK again to exit', 2500); }
      }
      else return;
    }
    e.preventDefault();
  }

  /* ---------------- browser mode (TV web browser / PC) ---------------- */
  // Scale the 1920x1080 layout to whatever size the browser window is.
  function fitToWindow() {
    if (Player.native) return;
    var k = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var s = document.body.style;
    s.webkitTransformOrigin = s.transformOrigin = '0 0';
    s.webkitTransform = s.transform = 'scale(' + k + ')';
  }
  // A web browser can only play HLS (.m3u8) streams, not raw MPEG-TS ones.
  function browserFilter(list) {
    if (Player.native) return list;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var urls = [];
      for (var j = 0; j < list[i].urls.length; j++) {
        if (/\.m3u8(\?|$)/i.test(list[i].urls[j])) urls.push(list[i].urls[j]);
      }
      if (urls.length) { list[i].urls = urls; out.push(list[i]); }
    }
    return out;
  }

  /* ---------------- start ---------------- */
  function init() {
    var boot = document.getElementById('boot');
    if (boot) boot.parentNode.removeChild(boot);
    fitToWindow();
    window.addEventListener('resize', fitToWindow);
    registerKeys();
    document.addEventListener('keydown', onKey);

    var cached = load('gtv.playlist');
    var idx = applyPlaylist(cached);
    $('list-status').textContent = channels.length + ' channels';
    tune(idx >= 0 ? idx : 0);

    if (!load('gtv.seenHint')) {
      save('gtv.seenHint', '1');
      setTimeout(function () { toast('Press OK for the channel list · ▲▼ or CH+/CH− to switch channels', 6000); }, 1500);
    }

    refreshPlaylist(false);
    setInterval(function () { refreshPlaylist(false); }, 6 * 3600 * 1000);
    setInterval(clock, 20000);

    // stop the stream when the app goes to the background, resume when it comes back
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { clearTimers(); Player.stop(); playing = false; }
      else if (cur >= 0) tune(cur);
    });

    // expose for debugging in a PC browser
    window.GTV = { channels: function () { return channels; }, tune: tune, current: function () { return cur; } };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
