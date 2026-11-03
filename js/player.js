/*
 * Player wrapper.
 *  - On a Samsung TV it uses Samsung's native AVPlay engine (handles HLS and
 *    MPEG-TS streams, hardware decoding, most reliable).
 *  - In a normal browser (for testing on a PC) it falls back to <video> + hls.js.
 *
 * Player.play(url, { onPlaying, onBuffering(pct), onError(msg) })
 * Player.stop()
 */
var Player = (function () {
  var hasAV = false;
  try { hasAV = typeof webapis !== 'undefined' && !!webapis.avplay; } catch (e) {}

  var session = 0;          // bumps on every play(), so callbacks from an old stream are ignored
  var video = null, hls = null;

  function avRect() {
    // AVPlay coordinates are in TV screen pixels; our page is 1920 wide.
    var sw = (window.screen && window.screen.width) || 1920;
    var k = sw / 1920;
    try { webapis.avplay.setDisplayRect(0, 0, Math.round(1920 * k), Math.round(1080 * k)); } catch (e) {}
  }

  function avStop() {
    try { webapis.avplay.stop(); } catch (e) {}
    try { webapis.avplay.close(); } catch (e) {}
  }

  function avPlay(url, cb, my) {
    avStop();
    try {
      webapis.avplay.open(url);
      webapis.avplay.setListener({
        onbufferingstart: function () { if (my === session) cb.onBuffering(0); },
        onbufferingprogress: function (p) { if (my === session) cb.onBuffering(p); },
        onbufferingcomplete: function () { if (my === session) cb.onPlaying(); },
        onstreamcompleted: function () { if (my === session) cb.onError('Stream ended'); },
        onerror: function (err) { if (my === session) cb.onError('Player error: ' + err); },
        onevent: function () {}
      });
      avRect();
      try { webapis.avplay.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
      try { webapis.avplay.setTimeoutForBuffering(20); } catch (e) {}
      webapis.avplay.prepareAsync(function () {
        if (my !== session) return;
        try { webapis.avplay.play(); cb.onPlaying(); } catch (e) { cb.onError('play: ' + e.message); }
      }, function (err) {
        if (my === session) cb.onError('Could not open stream (' + (err && err.name || err) + ')');
      });
    } catch (e) {
      cb.onError('open: ' + (e.message || e.name || e));
    }
  }

  function htmlStop() {
    if (hls) { try { hls.destroy(); } catch (e) {} hls = null; }
    if (video) {
      video.onplaying = video.onwaiting = video.onerror = video.ontimeupdate = null;
      try { video.pause(); video.removeAttribute('src'); video.load(); } catch (e) {}
    }
  }

  // TV browsers have a hardware HLS player; JavaScript decoding (hls.js) is too heavy for them.
  var isTV = /Tizen|SMART-TV|SmartTV|SMART TV|Maple|HbbTV|NetCast|Web0S/i.test(navigator.userAgent);

  function htmlPlay(url, cb, my, useHls) {
    video = video || document.getElementById('html-player');
    htmlStop();
    var isHls = /\.m3u8(\?|$)/i.test(url);
    var native = video.canPlayType('application/vnd.apple.mpegurl');
    var canHlsJs = !!(window.Hls && Hls.isSupported());
    if (useHls === undefined) useHls = isHls && canHlsJs && !native && !isTV;
    video.onplaying = function () { if (my === session) cb.onPlaying(); };
    video.onwaiting = function () { if (my === session) cb.onBuffering(0); };
    // Old TV browsers often don't fire 'playing' again after a short stall,
    // so treat "the picture is moving" (currentTime advancing) as playing.
    var lastT = -1;
    video.ontimeupdate = function () {
      if (my !== session) return;
      var t = video.currentTime;
      if (t !== lastT) { if (lastT >= 0) cb.onPlaying(); lastT = t; }
    };
    video.onerror = function () {
      if (my !== session) return;
      // the built-in player could not open it: try the JavaScript player once
      if (!useHls && isHls && canHlsJs) htmlPlay(url, cb, my, true);
      else cb.onError('Video error');
    };
    if (useHls) {
      hls = new Hls({
        liveSyncDurationCount: 3, maxBufferLength: 20, startLevel: 0,
        capLevelToPlayerSize: true, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2
      });
      hls.on(Hls.Events.ERROR, function (ev, data) {
        if (my === session && data.fatal) cb.onError('Stream error: ' + data.details);
      });
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
    }
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  if (!hasAV) document.body.className += ' html5';

  return {
    native: hasAV,
    play: function (url, cb) {
      session++;
      var my = session;
      cb.onBuffering(0);
      if (hasAV) avPlay(url, cb, my); else htmlPlay(url, cb, my);
    },
    stop: function () {
      session++;
      if (hasAV) avStop(); else htmlStop();
    },
    suspend: function () { if (hasAV) { try { webapis.avplay.suspend(); } catch (e) {} } },
    restore: function () { if (hasAV) { try { webapis.avplay.restore(); } catch (e) {} } }
  };
})();
