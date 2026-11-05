(() => {
  const socket = io();
  const cv = document.getElementById('c');
  const ctx = cv.getContext('2d');
  const menu = document.getElementById('menu');
  const nameInput = document.getElementById('name');

  const COLORS = {
    red: '#ff4d5e', redDark: '#8e1f2b',
    blue: '#4d9dff', blueDark: '#1d4785',
  };
  const P_R = MAP.P_R;
  const SPEED = MAP.SPEED;
  const VIEW = 1100; // ancho aproximado de mundo visible (px)

  let myId = null;
  let joinData = null;
  let state = null;
  let stateAt = 0;
  const disp = {}; // posiciones suavizadas por jugador
  let feed = [];
  let myHitAt = 0;
  let W = 0, H = 0, dpr = 1;

  // Prediccion local: mi jugador se mueve al instante sin esperar al servidor,
  // y se corrige suavemente con lo que el servidor confirma.
  const pred = { x: 0, y: 0, ok: false };
  let seq = 0;
  const hist = []; // posiciones predichas por numero de input enviado
  let lastFrame = performance.now();

  // ---------- Menu ----------
  let chosenTeam = 'auto';
  try { nameInput.value = localStorage.getItem('rva_name') || ''; } catch (e) {}
  document.querySelectorAll('.teams button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.teams button').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      chosenTeam = b.dataset.team;
    };
  });
  document.getElementById('play').onclick = () => {
    const name = nameInput.value.trim() || 'Jugador';
    try { localStorage.setItem('rva_name', name); } catch (e) {}
    joinData = { name, team: chosenTeam };
    socket.emit('join', joinData);
    menu.style.display = 'none';
    document.body.classList.add('playing');
    const el = document.documentElement;
    if (el.requestFullscreen && matchMedia('(pointer: coarse)').matches) {
      el.requestFullscreen().then(() => {
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {});
      }).catch(() => {});
    }
  };

  // ---------- Red ----------
  socket.on('connect', () => {
    if (joinData) socket.emit('join', joinData); // reconexion
  });
  socket.on('welcome', (d) => {
    myId = d.id;
    // Si eligio "auto", recordamos el equipo asignado para reconexiones.
    if (joinData) joinData.team = d.team;
  });
  socket.on('state', (s) => {
    state = s;
    stateAt = performance.now();
    for (const p of s.p) {
      let d = disp[p.id];
      if (!d) d = disp[p.id] = { x: p.x, y: p.y, a: p.a, hp: p.hp, hitAt: 0, al: p.al };
      if (p.hp < d.hp && p.al) {
        d.hitAt = performance.now();
        if (p.id === myId) myHitAt = d.hitAt;
      }
      if (!p.al && d.al && p.id === myId) myHitAt = performance.now();
      if (p.al && !d.al) { d.x = p.x; d.y = p.y; } // respawn: sin deslizar
      d.hp = p.hp;
      d.al = p.al;
    }
    for (const id in disp) if (!s.p.some((p) => p.id === id)) delete disp[id];

    const mine = s.p.find((p) => p.id === myId);
    if (mine) reconcile(mine, s);
  });

  function reconcile(mine, s) {
    if (!mine.al || !pred.ok || s.w) {
      pred.x = mine.x;
      pred.y = mine.y;
      pred.ok = mine.al && !s.w;
      hist.length = 0;
      return;
    }
    while (hist.length && hist[0].q < mine.q) hist.shift();
    const h = hist.length && hist[0].q === mine.q ? hist[0] : null;
    if (!h) {
      if (Math.hypot(mine.x - pred.x, mine.y - pred.y) > 250) { pred.x = mine.x; pred.y = mine.y; }
      return;
    }
    const ex = mine.x - h.x;
    const ey = mine.y - h.y;
    const err = Math.hypot(ex, ey);
    if (err > 150) {
      pred.x = mine.x; pred.y = mine.y; hist.length = 0;
    } else if (err > 4) {
      const k = 0.25;
      pred.x += ex * k; pred.y += ey * k;
      for (const e of hist) { e.x += ex * k; e.y += ey * k; }
    }
  }
  socket.on('feed', (msg) => {
    feed.push({ msg, at: performance.now() });
    if (feed.length > 5) feed.shift();
  });

  // ---------- Controles ----------
  const input = { mx: 0, my: 0, a: 0, shoot: false };
  const JOY_R = 60;
  const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
  let fireId = null;
  const keys = {};
  let mouseShoot = false;

  function fireBtn() {
    const r = Math.max(48, Math.min(70, H * 0.13));
    return { x: W - r - 34, y: H - r - 34, r };
  }

  function onTouchStart(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      const fb = fireBtn();
      const onFire = Math.hypot(t.clientX - fb.x, t.clientY - fb.y) < fb.r * 1.5;
      if ((onFire || t.clientX > W / 2) && fireId === null) {
        fireId = t.identifier;
        input.shoot = true;
      } else if (t.clientX <= W / 2 && joy.id === null) {
        joy.id = t.identifier;
        joy.ox = joy.x = t.clientX;
        joy.oy = joy.y = t.clientY;
      }
    }
  }
  function onTouchMove(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier !== joy.id) continue;
      let dx = t.clientX - joy.ox;
      let dy = t.clientY - joy.oy;
      const len = Math.hypot(dx, dy);
      if (len > JOY_R) {
        // el analogico "sigue" al dedo si se pasa del borde
        joy.ox += (dx / len) * (len - JOY_R);
        joy.oy += (dy / len) * (len - JOY_R);
        dx = t.clientX - joy.ox;
        dy = t.clientY - joy.oy;
      }
      joy.x = t.clientX;
      joy.y = t.clientY;
      input.mx = dx / JOY_R;
      input.my = dy / JOY_R;
      if (len > 10) input.a = Math.atan2(dy, dx);
    }
  }
  function onTouchEnd(e) {
    e.preventDefault();
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        joy.id = null;
        input.mx = input.my = 0;
      }
      if (t.identifier === fireId) {
        fireId = null;
        input.shoot = false;
      }
    }
  }
  cv.addEventListener('touchstart', onTouchStart, { passive: false });
  cv.addEventListener('touchmove', onTouchMove, { passive: false });
  cv.addEventListener('touchend', onTouchEnd, { passive: false });
  cv.addEventListener('touchcancel', onTouchEnd, { passive: false });

  // Teclado + mouse (para probar en la PC)
  addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'Space') e.preventDefault(); });
  addEventListener('keyup', (e) => { keys[e.code] = false; });
  cv.addEventListener('mousemove', (e) => { input.a = Math.atan2(e.clientY - H / 2, e.clientX - W / 2); });
  cv.addEventListener('mousedown', () => { mouseShoot = true; });
  addEventListener('mouseup', () => { mouseShoot = false; });

  function keyboardInput() {
    if (joy.id !== null) return null;
    let mx = 0, my = 0;
    if (keys.KeyA || keys.ArrowLeft) mx -= 1;
    if (keys.KeyD || keys.ArrowRight) mx += 1;
    if (keys.KeyW || keys.ArrowUp) my -= 1;
    if (keys.KeyS || keys.ArrowDown) my += 1;
    return { mx, my };
  }

  function currentMove() {
    const k = keyboardInput();
    let mx = input.mx, my = input.my;
    if (k && (k.mx || k.my)) { mx = k.mx; my = k.my; }
    const m = Math.hypot(mx, my);
    if (m > 1) { mx /= m; my /= m; }
    return { mx, my };
  }

  setInterval(() => {
    if (!myId) return;
    const mv = currentMove();
    const out = {
      mx: mv.mx, my: mv.my, a: input.a,
      shoot: input.shoot || mouseShoot || !!keys.Space,
      q: ++seq,
    };
    hist.push({ q: seq, x: pred.x, y: pred.y });
    if (hist.length > 120) hist.shift();
    socket.volatile.emit('input', out);
  }, 1000 / 30);

  // ---------- Dibujo ----------
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = innerWidth;
    H = innerHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = W + 'px';
    cv.style.height = H + 'px';
  }
  addEventListener('resize', resize);
  resize();

  const lerpAngle = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

  function drawWorld(now, me) {
    const s = Math.max(W, H) / VIEW;
    ctx.save();
    ctx.translate(W / 2, H / 2);
    ctx.scale(s, s);
    ctx.translate(-me.x, -me.y);

    // Suelo
    ctx.fillStyle = '#1c2330';
    ctx.fillRect(0, 0, MAP.W, MAP.H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x <= MAP.W; x += 100) { ctx.moveTo(x, 0); ctx.lineTo(x, MAP.H); }
    for (let y = 0; y <= MAP.H; y += 100) { ctx.moveTo(0, y); ctx.lineTo(MAP.W, y); }
    ctx.stroke();

    // Bases
    const sr = MAP.spawns.red, sb = MAP.spawns.blue;
    ctx.fillStyle = 'rgba(255,77,94,0.12)';
    ctx.fillRect(sr.x - 40, sr.y - 40, sr.w + 80, sr.h + 80);
    ctx.fillStyle = 'rgba(77,157,255,0.12)';
    ctx.fillRect(sb.x - 40, sb.y - 40, sb.w + 80, sb.h + 80);
    // Linea central
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.setLineDash([20, 20]);
    ctx.beginPath(); ctx.moveTo(MAP.W / 2, 0); ctx.lineTo(MAP.W / 2, MAP.H); ctx.stroke();
    ctx.setLineDash([]);

    // Borde
    ctx.strokeStyle = '#3d485c';
    ctx.lineWidth = 10;
    ctx.strokeRect(-5, -5, MAP.W + 10, MAP.H + 10);

    // Paredes (con sombra)
    for (const w of MAP.walls) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(w.x + 8, w.y + 10, w.w, w.h);
    }
    for (const w of MAP.walls) {
      ctx.fillStyle = '#4a5468';
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.fillStyle = '#5d6980';
      ctx.fillRect(w.x, w.y, w.w, 8);
    }

    // Balas (extrapoladas desde el ultimo estado)
    const dt = Math.min((now - stateAt) / 1000, 0.1);
    for (const [, x, y, vx, vy, team] of state.b) {
      const bx = x + vx * dt, by = y + vy * dt;
      const sp = Math.hypot(vx, vy) || 1;
      ctx.strokeStyle = team === 0 ? 'rgba(255,120,130,0.5)' : 'rgba(120,180,255,0.5)';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(bx - (vx / sp) * 26, by - (vy / sp) * 26);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.fillStyle = '#fff8d0';
      ctx.beginPath(); ctx.arc(bx, by, 5, 0, Math.PI * 2); ctx.fill();
    }

    // Jugadores
    for (const p of state.p) {
      if (!p.al) continue;
      const d = disp[p.id];
      const col = COLORS[p.t], dark = COLORS[p.t + 'Dark'];
      ctx.save();
      ctx.translate(d.x, d.y);

      // sombra
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(4, 8, P_R, P_R * 0.8, 0, 0, Math.PI * 2); ctx.fill();

      ctx.rotate(d.a);
      // arma
      ctx.fillStyle = '#222';
      ctx.fillRect(6, -6, P_R + 14, 12);
      if (p.sf) {
        ctx.fillStyle = '#ffe27a';
        ctx.beginPath(); ctx.arc(P_R + 24, 0, 9, 0, Math.PI * 2); ctx.fill();
      }
      // cuerpo
      ctx.fillStyle = dark;
      ctx.beginPath(); ctx.arc(0, 0, P_R, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(0, 0, P_R - 5, 0, Math.PI * 2); ctx.fill();
      // flash de impacto
      if (now - d.hitAt < 110) {
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath(); ctx.arc(0, 0, P_R, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      ctx.save();
      ctx.translate(d.x, d.y);
      if (p.id === myId) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(0, 0, P_R + 5, 0, Math.PI * 2); ctx.stroke();
      }
      if (p.sp) {
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.3 + 0.3 * Math.sin(now / 80)) + ')';
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(0, 0, P_R + 12, 0, Math.PI * 2); ctx.stroke();
      }
      // barra de vida
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(-26, -P_R - 18, 52, 7);
      ctx.fillStyle = p.hp > 50 ? '#5ee07a' : p.hp > 25 ? '#f2c94c' : '#ff5a5a';
      ctx.fillRect(-26, -P_R - 18, 52 * Math.max(0, p.hp) / 100, 7);
      // nombre
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillText(p.n, 1, -P_R - 24);
      ctx.fillStyle = '#fff';
      ctx.fillText(p.n, 0, -P_R - 25);
      ctx.restore();
    }

    ctx.restore();
  }

  function drawMinimap(meP) {
    const mw = Math.min(170, W * 0.22);
    const mh = mw * (MAP.H / MAP.W);
    const x0 = 12, y0 = 12;
    const k = mw / MAP.W;
    ctx.fillStyle = 'rgba(10,14,20,0.7)';
    ctx.fillRect(x0, y0, mw, mh);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    for (const w of MAP.walls) ctx.fillRect(x0 + w.x * k, y0 + w.y * k, Math.max(1, w.w * k), Math.max(1, w.h * k));
    for (const p of state.p) {
      if (!p.al) continue;
      // solo se ven los compañeros (y uno mismo)
      if (meP && p.t !== meP.t) continue;
      const d = disp[p.id];
      ctx.fillStyle = p.id === myId ? '#fff' : COLORS[p.t];
      ctx.beginPath(); ctx.arc(x0 + d.x * k, y0 + d.y * k, p.id === myId ? 3.5 : 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x0, y0, mw, mh);
  }

  function drawHUD(now, meP) {
    // Marcador
    const s = state.s;
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px system-ui, sans-serif';
    const cx = W / 2;
    ctx.fillStyle = 'rgba(10,14,20,0.65)';
    ctx.fillRect(cx - 110, 8, 220, 40);
    ctx.fillStyle = COLORS.red;
    ctx.fillText(s.red, cx - 55, 38);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText('a ' + state.win, cx, 33);
    ctx.font = 'bold 26px system-ui, sans-serif';
    ctx.fillStyle = COLORS.blue;
    ctx.fillText(s.blue, cx + 55, 38);

    // Feed de bajas
    ctx.textAlign = 'right';
    ctx.font = '14px system-ui, sans-serif';
    let fy = 26;
    feed = feed.filter((f) => now - f.at < 5000);
    for (const f of feed) {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      const tw = ctx.measureText(f.msg).width;
      ctx.fillRect(W - tw - 22, fy - 15, tw + 12, 21);
      ctx.fillStyle = '#fff';
      ctx.fillText(f.msg, W - 16, fy);
      fy += 24;
    }

    if (meP) {
      // Mis stats
      ctx.textAlign = 'center';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(`Bajas ${meP.k}  ·  Muertes ${meP.d}`, cx, 66);

      // Vineta roja al recibir daño
      const since = now - myHitAt;
      if (since < 300) {
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.7);
        g.addColorStop(0, 'rgba(255,0,0,0)');
        g.addColorStop(1, `rgba(255,0,0,${0.45 * (1 - since / 300)})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      }

      if (!meP.al && !state.w) {
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = 'bold 34px system-ui, sans-serif';
        ctx.fillText('Te eliminaron', W / 2, H / 2 - 10);
        ctx.font = '20px system-ui, sans-serif';
        ctx.fillText(`Reapareces en ${Math.ceil(meP.rs / 1000)}…`, W / 2, H / 2 + 24);
      }
    }

    if (state.w) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(0, 0, W, H);
      ctx.textAlign = 'center';
      ctx.font = 'bold 46px system-ui, sans-serif';
      ctx.fillStyle = COLORS[state.w];
      ctx.fillText(`¡GANA EL ${state.w === 'red' ? 'ROJO' : 'AZUL'}!`, W / 2, H / 2);
      ctx.font = '18px system-ui, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('Nueva ronda en unos segundos…', W / 2, H / 2 + 36);
    }
  }

  function drawControls() {
    if (!matchMedia('(pointer: coarse)').matches) return;
    // Analogico
    const baseX = joy.id !== null ? joy.ox : 110;
    const baseY = joy.id !== null ? joy.oy : H - 110;
    const knobX = joy.id !== null ? joy.x : baseX;
    const knobY = joy.id !== null ? joy.y : baseY;
    ctx.globalAlpha = joy.id !== null ? 0.9 : 0.4;
    ctx.fillStyle = 'rgba(255,255,255,0.12)';
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(baseX, baseY, JOY_R, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath(); ctx.arc(knobX, knobY, 26, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;

    // Boton de disparo
    const fb = fireBtn();
    ctx.fillStyle = fireId !== null ? 'rgba(255,90,90,0.75)' : 'rgba(255,90,90,0.4)';
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(fb.x, fb.y, fb.r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    // icono mira
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(fb.x, fb.y, fb.r * 0.35, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(fb.x - fb.r * 0.6, fb.y); ctx.lineTo(fb.x - fb.r * 0.2, fb.y);
    ctx.moveTo(fb.x + fb.r * 0.2, fb.y); ctx.lineTo(fb.x + fb.r * 0.6, fb.y);
    ctx.moveTo(fb.x, fb.y - fb.r * 0.6); ctx.lineTo(fb.x, fb.y - fb.r * 0.2);
    ctx.moveTo(fb.x, fb.y + fb.r * 0.2); ctx.lineTo(fb.x, fb.y + fb.r * 0.6);
    ctx.stroke();
  }

  function frame() {
    requestAnimationFrame(frame);
    const now = performance.now();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#11151c';
    ctx.fillRect(0, 0, W, H);
    if (!state || !myId) return;

    // Suavizado de posiciones
    for (const p of state.p) {
      const d = disp[p.id];
      if (!d) continue;
      d.x += (p.x - d.x) * 0.35;
      d.y += (p.y - d.y) * 0.35;
      d.a = lerpAngle(d.a, p.a, 0.5);
    }

    const meP = state.p.find((p) => p.id === myId);

    // Mi jugador: posicion predicha localmente y apuntado instantaneo.
    const dtF = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    if (meP && disp[myId] && pred.ok && meP.al && !state.w) {
      const mv = currentMove();
      pred.x += mv.mx * SPEED * dtF;
      pred.y += mv.my * SPEED * dtF;
      MAP.resolve(pred, P_R);
      disp[myId].x = pred.x;
      disp[myId].y = pred.y;
      disp[myId].a = input.shoot || mouseShoot || keys.Space ? disp[myId].a : input.a;
    }

    const me = meP ? disp[myId] : { x: MAP.W / 2, y: MAP.H / 2 };
    drawWorld(now, me);
    drawMinimap(meP);
    drawHUD(now, meP);
    drawControls();
  }
  requestAnimationFrame(frame);
})();
