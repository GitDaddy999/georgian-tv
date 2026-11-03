/*
 * Channel list.
 *
 * BUILTIN_CHANNELS is the backup list that ships inside the app.
 * On every start the app also downloads the public Georgian playlist from the
 * open-source iptv-org project (PLAYLIST_SOURCES) and merges it in, so when a
 * channel changes its stream address the app picks it up without reinstalling.
 *
 * Each channel can have several stream addresses ("urls"); if one fails or
 * freezes, the app automatically tries the next one.
 *
 * To add or fix a channel yourself, just edit this list.
 */

var PLAYLIST_SOURCES = [
  'ge.m3u',   // copy kept fresh by the home server (works without https)
  'https://iptv-org.github.io/iptv/countries/ge.m3u',
  'https://raw.githubusercontent.com/iptv-org/iptv/master/streams/ge.m3u'
];

var BUILTIN_CHANNELS = [
  { id: '1TV.ge', name: '1TV', ka: 'პირველი არხი', urls: [
      'https://tv.cdn.xsg.ge/gpb-1tv/index.m3u8',
      'http://nue01-edge01.itdc.ge/gpb/mpegts' ] },
  { id: '2TV.ge', name: '2TV', ka: 'მეორე არხი', urls: [
      'https://tv.cdn.xsg.ge/gpb-2tv/index.m3u8' ] },
  { id: 'ImediTV.ge', name: 'Imedi TV', ka: 'იმედი', urls: [
      'https://tv.cdn.xsg.ge/imedihd/index.m3u8',
      'http://nue01-edge01.itdc.ge/imedihd/mpegts' ] },
  { id: 'Rustavi2.ge', name: 'Rustavi 2', ka: 'რუსთავი 2', urls: [
      'http://nue01-edge01.itdc.ge/rustavi2hqnew/mpegts',
      'http://31.146.5.178:8087/play/a008/index.m3u8' ] },
  { id: 'Formula.ge', name: 'Formula', ka: 'ფორმულა', urls: [
      'https://c4635.cdn.xsg.ge/c4635/TVFormula/index.m3u8',
      'https://tv.cdn.xsg.ge/c4635/TVFormula/playlist.m3u8' ] },
  { id: 'TVPirveli.ge', name: 'TV Pirveli', ka: 'ტვ პირველი', urls: [
      'http://nue01-edge01.itdc.ge/pirvelitv/mpegts' ] },
  { id: 'PalitraNews.ge', name: 'Palitra News', ka: 'პალიტრა ნიუსი', urls: [
      'https://live.palitranews.ge/hls/palitratv/index.m3u8',
      'https://livestream.palitra.ge/hls/palitratv/index.m3u8' ] },
  { id: 'EuronewsGeorgia.ge', name: 'Euronews Georgia', ka: 'ევრონიუსი საქართველო', urls: [
      'http://nue01-edge01.itdc.ge/euronewsgeorgia/mpegts' ] },
  { id: 'TVC.ge', name: 'TVC', ka: '', urls: [
      'http://31.146.5.178:8087/play/a009/index.m3u8' ] },
  { id: 'ComedyTV.ge', name: 'Comedy TV', ka: 'კომედი', urls: [
      'http://31.146.5.178:8087/play/a00b/index.m3u8' ] },
  { id: 'GDSTV.ge', name: 'GDS TV', ka: '', urls: [
      'http://31.146.5.178:8087/play/a00a/index.m3u8' ] },
  { id: 'ObieqtiviTV.ge', name: 'Obieqtivi TV', ka: 'ობიექტივი', urls: [
      'https://live20.bozztv.com/dvrfl05/gin-obieqtivitv/index.m3u8' ] },
  { id: 'BMGTV.ge', name: 'BMG TV', ka: '', urls: [
      'https://tv.nucast.tv/lb/ge/bmg/index.m3u8' ] },
  { id: 'RioniTV.ge', name: 'Rioni TV', ka: 'რიონი', urls: [
      'http://video.rionitv.com:9090/hls/live/rioni.m3u8' ] },
  { id: 'Ertsulovneba.ge', name: 'Ertsulovneba', ka: 'ერთსულოვნება', urls: [
      'https://stream.sstv.ge/live/sstv/playlist.m3u8' ] }
];

/* ---------- playlist parsing / merging ---------- */

function parseM3U(text) {
  var lines = text.split(/\r?\n/), out = [], cur = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf('#EXTINF') === 0) {
      var idm = line.match(/tvg-id="([^"]*)"/);
      var name = line.substring(line.lastIndexOf(',') + 1);
      cur = { id: idm ? idm[1].split('@')[0] : '', rawName: name, needsHeaders: false };
    } else if (line.indexOf('#EXTVLCOPT') === 0 || line.indexOf('#KODIPROP') === 0) {
      if (cur) cur.needsHeaders = true;          // TVs can't send custom headers — skip these
    } else if (line.charAt(0) !== '#' && cur) {
      cur.url = line;
      out.push(cur);
      cur = null;
    }
  }
  return out;
}

function cleanName(n) {
  return n.replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
}

function channelKey(id, name) {
  return (id || cleanName(name)).toLowerCase().replace(/[^a-z0-9.]/g, '');
}

/* Returns a new list: built-in channels (with fresh URLs first) + any new channels from the playlist. */
function mergeChannels(builtin, entries) {
  var list = [], byKey = {}, i, j;
  for (i = 0; i < builtin.length; i++) {
    var c = builtin[i];
    var copy = { id: c.id, name: c.name, ka: c.ka, urls: [] };
    list.push(copy);
    byKey[channelKey(c.id, c.name)] = copy;
    byKey[channelKey('', c.name)] = copy;
  }
  var fresh = {};   // key -> urls from the online playlist, in order
  for (i = 0; i < entries.length; i++) {
    var e = entries[i];
    if (e.needsHeaders || !/^https?:\/\//.test(e.url)) continue;
    if (/\.php(\?|$)/i.test(e.url)) continue;     // skip re-streaming proxies, keep direct stream links
    var key = channelKey(e.id, e.rawName);
    var target = byKey[key] || byKey[channelKey('', e.rawName)];
    if (!target) {
      target = { id: e.id, name: cleanName(e.rawName), ka: '', urls: [] };
      list.push(target);
      byKey[key] = target;
    }
    var k2 = target.id || target.name;
    (fresh[k2] = fresh[k2] || []).push(e.url);
  }
  // online URLs first (they're the newest), then the built-in ones as backup
  for (i = 0; i < list.length; i++) {
    var ch = list[i], urls = fresh[ch.id || ch.name] || [];
    var orig = null;
    for (j = 0; j < builtin.length; j++) if (builtin[j].id === ch.id) orig = builtin[j];
    if (orig) urls = urls.concat(orig.urls);
    var seen = {};
    for (j = 0; j < urls.length; j++) {
      if (!seen[urls[j]]) { seen[urls[j]] = 1; ch.urls.push(urls[j]); }
    }
  }
  return list.filter(function (c) { return c.urls.length > 0; });
}
