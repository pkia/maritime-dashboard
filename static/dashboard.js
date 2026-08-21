// Maritime Dashboard frontend logic
(function () {
    'use strict';

    // ---------- Tab switching + auto-rotation ----------
    var tabs = document.querySelectorAll('.tab');
    function activateTab(name) {
        tabs.forEach(function (x) { x.classList.remove('active'); });
        document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
        var btn = document.querySelector('.tab[data-tab="' + name + '"]');
        if (btn) btn.classList.add('active');
        document.getElementById('tab-' + name).classList.add('active');
    }
    tabs.forEach(function (t) {
        t.addEventListener('click', function () { activateTab(t.dataset.tab); pauseRotation(); });
    });
    document.querySelectorAll('[data-goto]').forEach(function (el) {
        el.addEventListener('click', function () { activateTab(el.dataset.goto); pauseRotation(); });
    });

    // Auto-rotation: map 90s -> RF 20s -> satellites 15s, loop.
    // Any manual tab tap pauses it for 5 minutes. ?norotate disables (testing).
    var rotating = location.search.indexOf('norotate') === -1;
    var rotationTimer = null;
    var resumeTimer = null;
    var rotationSteps = [['ais', 90], ['online', 45], ['rf', 20], ['noaa', 15]];
    var rotIdx = 0;
    var rotateBtn = document.getElementById('auto-rotate');

    function nextStep() {
        rotIdx = (rotIdx + 1) % rotationSteps.length;
        activateTab(rotationSteps[rotIdx][0]);
        scheduleStep();
    }
    function scheduleStep() {
        clearTimeout(rotationTimer);
        if (rotating) rotationTimer = setTimeout(nextStep, rotationSteps[rotIdx][1] * 1000);
    }
    function pauseRotation() {
        clearTimeout(resumeTimer);
        resumeTimer = setTimeout(function () { if (rotating) scheduleStep(); }, 5 * 60 * 1000);
    }
    rotateBtn.addEventListener('click', function () {
        rotating = !rotating;
        rotateBtn.textContent = rotating ? '▶' : '⏸';
        rotateBtn.classList.toggle('on', rotating);
        if (rotating) { rotIdx = 0; activateTab('ais'); scheduleStep(); }
        else clearTimeout(rotationTimer);
    });
    rotateBtn.classList.add('on');
    var homeBtn = document.getElementById('home-btn');
    if (homeBtn) homeBtn.addEventListener('click', function () {
        // Back to the kiosk chooser (kiosk-home on :8091)
        location.href = location.protocol + '//' + location.hostname + ':8091/';
    });
    var startTab = new URLSearchParams(location.search).get('tab');
    if (startTab && document.getElementById('tab-' + startTab)) {
        rotIdx = Math.max(0, rotationSteps.findIndex(function (s) { return s[0] === startTab; }));
        if (rotIdx < 0) rotIdx = 0;
        activateTab(rotationSteps[rotIdx][0] || startTab);
    } else {
        activateTab('ais');
    }
    scheduleStep();

    // ---------- Clock + next pass countdown ----------
    var nextPassInfo = '';
    function tick() {
        var d = new Date();
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        var ss = String(d.getSeconds()).padStart(2, '0');
        var dateStr = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
        // Update the dedicated spans only - rewriting the whole bar would
        // destroy the buttons that live in it (#home-btn, #auto-rotate).
        document.getElementById('clock-time').textContent = hh + ':' + mm + ':' + ss;
        document.getElementById('clock-right').textContent =
            dateStr + (nextPassInfo ? ' · 🛰️ ' + nextPassInfo : '');
    }
    setInterval(tick, 1000);
    tick();

    // ---------- System status polling ----------
    function setStatus(el, ok, text) {
        el.textContent = text;
        el.className = ok === null ? '' : (ok ? 'status-ok' : 'status-err');
    }

    function refreshStatus() {
        fetch('/api/status')
            .then(function (r) { return r.json(); })
            .then(function (s) {
                setStatus(document.getElementById('sdr-status'), s.sdr_detected, s.sdr_detected ? 'RTL-SDR Blog V4 detected' : 'NOT DETECTED');
                setStatus(document.getElementById('ais-status'), s.ais_running, s.ais_running ? 'Running (PID ' + s.ais_pid + ')' : 'Stopped');
                document.getElementById('msg-count').textContent = s.ais_messages;
                document.getElementById('uptime').textContent = s.uptime;
                document.getElementById('cpu-temp').textContent = s.cpu_temp;
                document.getElementById('mem-usage').textContent = s.mem_used + ' / ' + s.mem_total;
                document.getElementById('sd-free').textContent = s.disk_free + ' free';
                setStatus(document.getElementById('touch-status'), s.touch_detected, s.touch_detected ? 'ILITEK multitouch active' : 'Not detected');

                // Signal bar: dB above noise floor in the AIS band
                var bar = document.getElementById('signal-bar');
                var fill = bar.querySelector('.signal-fill');
                var db = s.signal_db;
                var pct = Math.max(0, Math.min(100, db * 4));
                fill.style.width = pct + '%';
                bar.className = pct > 60 ? 'signal-high' : (pct > 25 ? 'signal-mid' : 'signal-low');
                document.getElementById('signal-db').textContent = db.toFixed(1) + ' dB over floor';
            })
            .catch(function () {
                document.getElementById('ais-status').textContent = 'API unreachable';
                document.getElementById('ais-status').className = 'status-err';
            });
    }
    setInterval(refreshStatus, 5000);
    refreshStatus();

    // ---------- NOAA / satellites tab ----------
    function refreshNoaa() {
        fetch('/api/noaa')
            .then(function (r) { return r.json(); })
            .then(function (n) {
                var passesEl = document.getElementById('noaa-passes');
                passesEl.innerHTML = '';
                if (!n.next_passes || n.next_passes.length === 0) {
                    passesEl.innerHTML = '<div class="noaa-none">No pass predictions available yet</div>';
                } else {
                    n.next_passes.forEach(function (p) {
                        var row = document.createElement('div');
                        row.className = 'pass-row' + (p.max_elevation > 30 ? ' elevated' : '');
                        row.innerHTML = '<span class="pass-sat">' + p.satellite + '</span>' +
                            '<span class="pass-time">' + p.start + '</span>' +
                            '<span class="pass-dir">' + (p.direction === 'N' ? '↑ asc' : '↓ desc') + '</span>' +
                            '<span class="pass-elev">' + p.max_elevation.toFixed(0) + '°</span>';
                        passesEl.appendChild(row);
                    });
                }

                var gallery = document.getElementById('noaa-gallery');
                gallery.innerHTML = '';
                if (!n.images || n.images.length === 0) {
                    gallery.innerHTML = '<div class="noaa-none">No satellite captures yet — waiting for first good pass</div>';
                } else {
                    n.images.forEach(function (img) {
                        var el = document.createElement('img');
                        el.src = img.url;
                        el.className = 'noaa-img';
                        el.title = img.caption;
                        gallery.appendChild(el);
                    });
                }

                document.getElementById('noaa-status').textContent =
                    n.capture_in_progress ? '🔴 Capturing satellite pass NOW — AIS paused' : n.status_message;

                // Latest satellite capture overlay on the AIS map
                var ov = document.getElementById('sat-overlay');
                if (n.images && n.images.length > 0) {
                    var latest = n.images[0];
                    document.getElementById('sat-overlay-img').src = latest.url + '?t=' + Date.now();
                    document.getElementById('sat-overlay-caption').textContent = latest.caption;
                    ov.classList.remove('hidden');
                } else {
                    ov.classList.add('hidden');
                }

                // Bottom-bar countdown to next good pass
                if (n.next_passes && n.next_passes.length > 0) {
                    var best = null;
                    n.next_passes.forEach(function (p) {
                        if (p.max_elevation >= 20 && (!best || p.max_elevation > best.max_elevation)) { best = p; }
                    });
                    var target = best || n.next_passes[0];
                    nextPassInfo = target.satellite + ' ' + target.start;
                }
            })
            .catch(function () {
                document.getElementById('noaa-status').textContent = 'NOAA API unreachable';
            });
    }
    setInterval(refreshNoaa, 30000);
    refreshNoaa();

    // ---------- RF spectrum + waterfall ----------
    var CHANNELS = [
        { f: 156.050, label: 'Ch 01' }, { f: 156.300, label: 'Ch 06' },
        { f: 156.400, label: 'Ch 08' }, { f: 156.450, label: 'Ch 09' },
        { f: 156.500, label: 'Ch 10' }, { f: 156.550, label: 'Ch 11' },
        { f: 156.575, label: 'Ch 71' }, { f: 156.600, label: 'Ch 12' },
        { f: 156.650, label: 'Ch 13' }, { f: 156.700, label: 'Ch 14' },
        { f: 156.750, label: 'Ch 74' }, { f: 156.800, label: 'Ch 16', ais: false, ch16: true },
        { f: 156.850, label: 'Ch 86' }, { f: 161.975, label: 'AIS A', ais: true },
        { f: 162.025, label: 'AIS B', ais: true },
    ];

    var specCanvas = document.getElementById('spectrum-canvas');
    var wfCanvas = document.getElementById('waterfall-canvas');
    var specData = null;

    function freqToX(f_mhz, w) {
        var f0 = specData ? specData.f_start / 1e6 : 155.5;
        var f1 = f0 + (specData ? specData.f_step * 200 / 1e6 : 7.5);
        return (f_mhz - f0) / (f1 - f0) * w;
    }

    function drawSpectrum() {
        if (!specData || !specData.scans.length) return;
        var ctx = specCanvas.getContext('2d');
        var w = specCanvas.width, h = specCanvas.height;
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#060d18';
        ctx.fillRect(0, 0, w, h);

        var scan = specData.scans[specData.scans.length - 1];
        var p = scan.p;
        var maxDb = 40; // dB above floor scale
        var pad = { l: 34, r: 8, t: 14, b: 30 };
        var plotW = w - pad.l - pad.r, plotH = h - pad.t - pad.b;

        // grid lines every 10 dB
        ctx.strokeStyle = '#15263f';
        ctx.fillStyle = '#5a7a9a';
        ctx.font = '10px monospace';
        ctx.lineWidth = 1;
        for (var db = 0; db <= maxDb; db += 10) {
            var y = pad.t + plotH - (db / maxDb) * plotH;
            ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
            ctx.fillText('+' + db + 'dB', 2, y + 3);
        }

        // channel markers
        CHANNELS.forEach(function (ch) {
            var x = freqToX(ch.f, w);
            ctx.strokeStyle = ch.ais ? '#ff5252' : (ch.ch16 ? '#ffab00' : '#40c4ff');
            ctx.globalAlpha = 0.35;
            ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.fillStyle = ch.ais ? '#ff8a80' : (ch.ch16 ? '#ffd54f' : '#82b1ff');
            ctx.fillText(ch.label, x - ctx.measureText(ch.label).width / 2, h - 16);
        });

        // spectrum trace
        ctx.beginPath();
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 1.5;
        for (var i = 0; i < p.length; i++) {
            var x = pad.l + (i / (p.length - 1)) * plotW;
            var y = pad.t + plotH - Math.max(0, Math.min(maxDb, p[i])) / maxDb * plotH;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();

        // highlight signal peaks (+10 dB over floor)
        ctx.fillStyle = '#69f0ae';
        for (var j = 0; j < p.length; j++) {
            if (p[j] > 10) {
                var px = pad.l + (j / (p.length - 1)) * plotW;
                var py = pad.t + plotH - Math.min(maxDb, p[j]) / maxDb * plotH;
                ctx.beginPath(); ctx.arc(px, py, 2.5, 0, 6.283); ctx.fill();
            }
        }

        // axis labels (MHz)
        ctx.fillStyle = '#5a7a9a';
        for (var fm = 156; fm <= 162; fm += 1) {
            var tx = freqToX(fm, w);
            ctx.fillText(fm + '', tx - 6, h - 4);
        }
        var mins = Math.round((Date.now() / 1000 - scan.t) / 60);
        document.getElementById('rf-last').textContent = mins <= 0 ? '(live)' : '(' + mins + ' min ago)';
    }

    function drawWaterfall() {
        if (!specData || !specData.scans.length) return;
        var ctx = wfCanvas.getContext('2d');
        var w = wfCanvas.width, h = wfCanvas.height;
        var scans = specData.scans;
        var rowH = Math.max(2, Math.floor(h / 60));
        var offset = Math.max(0, scans.length - Math.floor(h / rowH));

        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = '#060d18';
        ctx.fillRect(0, 0, w, h);

        for (var r = offset; r < scans.length; r++) {
            var p = scans[r].p;
            for (var i = 0; i < p.length; i++) {
                var v = Math.max(0, Math.min(45, p[i]));
                var x = (i / p.length) * w;
                if (v < 4) continue;
                // colour: dark blue -> cyan -> yellow -> red
                var cr, cg, cb;
                if (v < 15) { cr = 0; cg = (v - 4) * 17; cb = 200; }
                else if (v < 30) { cr = (v - 15) * 12; cg = 180; cb = 255 - (v - 15) * 12; }
                else { cr = 255; cg = 255 - (v - 30) * 12; cb = 0; }
                ctx.fillStyle = 'rgb(' + cr + ',' + cg + ',' + cb + ')';
                var bw = w / p.length + 1;
                ctx.fillRect(x, h - (r - offset + 1) * rowH, bw, rowH);
            }
        }
        // channel ticks
        ctx.fillStyle = 'rgba(255,255,255,0.55)';
        ctx.font = '9px monospace';
        CHANNELS.forEach(function (ch) {
            var x = freqToX(ch.f, w);
            ctx.fillText(ch.label, x - 10, 10);
        });
    }

    function refreshSpectrum() {
        fetch('/api/spectrum')
            .then(function (r) { return r.json(); })
            .then(function (d) { specData = d; drawSpectrum(); drawWaterfall(); })
            .catch(function () {});
    }
    setInterval(refreshSpectrum, 30000);
    refreshSpectrum();

    // ---------- Online ships overlay (aisstream.io) ----------
    // The map below is fixed at this view (fix_center, zoom 10), so we can
    // project lat/lon onto screen pixels directly with Web Mercator math.
    var MAP = { lat: 52.159428, lon: -7.14919, zoom: 10 };
    var olCanvas = document.getElementById('online-layer');

    function mercPx(lat, lon, worldPx) {
        var x = (lon + 180) / 360 * worldPx;
        var latR = lat * Math.PI / 180;
        var y = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * worldPx;
        return [x, y];
    }

    function drawOnlineShips(data) {
        var ctx = olCanvas.getContext('2d');
        var w = olCanvas.width = olCanvas.clientWidth;
        var h = olCanvas.height = olCanvas.clientHeight;
        ctx.clearRect(0, 0, w, h);
        document.getElementById('online-count').textContent = data.count || 0;
        if (!data.ships || !data.ships.length) return;

        var world = 256 * Math.pow(2, MAP.zoom);
        var c = mercPx(MAP.lat, MAP.lon, world);
        var pad = 40; // allow slight offscreen margin

        data.ships.forEach(function (s) {
            var p = mercPx(s.lat, s.lon, world);
            var x = p[0] - c[0] + w / 2;
            var y = p[1] - c[1] + h / 2;
            if (x < -pad || x > w + pad || y < -pad || y > h + pad) return;

            var cog = (s.cog || 0) * Math.PI / 180;
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(cog);

            // orange arrow marker
            ctx.fillStyle = '#ff9100';
            ctx.strokeStyle = '#4a2c00';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(0, -11);
            ctx.lineTo(7, 9);
            ctx.lineTo(0, 4);
            ctx.lineTo(-7, 9);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();

            // name tag
            if (s.name) {
                ctx.font = '10px sans-serif';
                var tw = ctx.measureText(s.name).width;
                ctx.fillStyle = 'rgba(10,22,40,0.75)';
                ctx.fillRect(x + 9, y - 7, tw + 6, 13);
                ctx.fillStyle = '#ffcc80';
                ctx.fillText(s.name, x + 12, y + 3);
            }
        });
    }

    function refreshOnlineShips() {
        fetch('/api/onlineships')
            .then(function (r) { return r.json(); })
            .then(drawOnlineShips)
            .catch(function () {});
    }
    setInterval(refreshOnlineShips, 20000);
    refreshOnlineShips();

    // ---------- Online tab: own map (OSM tiles + canvas markers) ----------
    function buildOnlineMap() {
        var container = document.getElementById('onlinemap-tiles');
        if (container.childElementCount) return; // already built
        var world = 256 * Math.pow(2, MAP.zoom);
        var c = mercPx(MAP.lat, MAP.lon, world);
        var vw = window.innerWidth, vh = window.innerHeight - 44 - 28;
        var left = c[0] - vw / 2, top = c[1] - vh / 2;
        var x0 = Math.floor(left / 256), x1 = Math.floor((left + vw) / 256);
        var y0 = Math.floor(top / 256), y1 = Math.floor((top + vh) / 256);
        for (var ty = y0; ty <= y1; ty++) {
            for (var tx = x0; tx <= x1; tx++) {
                if (ty < 0 || ty >= Math.pow(2, MAP.zoom)) continue;
                var img = document.createElement('img');
                img.src = 'https://tile.openstreetmap.org/' + MAP.zoom + '/' + tx + '/' + ty + '.png';
                img.style.left = (tx * 256 - left) + 'px';
                img.style.top = (ty * 256 - top) + 'px';
                container.appendChild(img);
            }
        }
    }

    function drawOnlineMapShips(data) {
        var cv = document.getElementById('onlinemap-canvas');
        var ctx = cv.getContext('2d');
        var w = cv.width = cv.clientWidth, h = cv.height = cv.clientHeight;
        ctx.clearRect(0, 0, w, h);
        var st = document.getElementById('onlinemap-status');
        if (data.ships && data.ships.length) {
            var world = 256 * Math.pow(2, MAP.zoom);
            var c = mercPx(MAP.lat, MAP.lon, world);
            data.ships.forEach(function (s) {
                var p = mercPx(s.lat, s.lon, world);
                var x = p[0] - c[0] + w / 2, y = p[1] - c[1] + h / 2;
                if (x < -30 || x > w + 30 || y < -30 || y > h + 30) return;
                ctx.save();
                ctx.translate(x, y);
                ctx.rotate((s.cog || 0) * Math.PI / 180);
                ctx.fillStyle = '#ff9100';
                ctx.strokeStyle = '#4a2c00'; ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(0, -14); ctx.lineTo(9, 11); ctx.lineTo(0, 5); ctx.lineTo(-9, 11);
                ctx.closePath(); ctx.fill(); ctx.stroke();
                ctx.restore();
                if (s.name) {
                    ctx.font = '11px sans-serif';
                    var tw = ctx.measureText(s.name).width;
                    ctx.fillStyle = 'rgba(10,22,40,0.8)';
                    ctx.fillRect(x + 11, y - 8, tw + 8, 15);
                    ctx.fillStyle = '#ffcc80';
                    ctx.fillText(s.name, x + 15, y + 3);
                }
            });
            st.innerHTML = '<b style="color:#69f0ae">' + data.count + ' ships</b> from online feed (aisstream.io)' +
                '<div class="hint">🟠 orange = internet data · white markers on AIS tab = this antenna</div>';
        } else {
            var msg = data.note || data.error || 'waiting';
            var extra = data.next_refresh ? ' · next refresh ' + data.next_refresh : '';
            st.innerHTML = '🌐 <b>Online feed</b> (' + (data.source || 'vesselapi') + '): ' + msg + extra +
                '<div class="hint">🟠 orange markers = internet data (this tab) · white markers on AIS tab = this antenna.' +
                ' The free API has a monthly request quota — it refreshes sparingly.</div>';
        }
    }

    function refreshOnlineMap() {
        buildOnlineMap();
        // Ask for a fresh upstream fetch ONLY while the Online tab is visible
        // (Flask throttles to 1 trigger/10 min anyway)
        var onlineVisible = document.getElementById('tab-online').classList.contains('active');
        if (onlineVisible) {
            fetch('/api/onlineships/refresh', { method: 'POST' }).catch(function () {});
        }
        fetch('/api/onlineships')
            .then(function (r) { return r.json(); })
            .then(drawOnlineMapShips)
            .catch(function () {});
    }
    setInterval(refreshOnlineMap, 20000);
    refreshOnlineMap();
})();
