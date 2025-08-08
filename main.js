/* FFTactics-like Vertical Slice Demo
   - Isometric 3D-ish map with 90° rotation, tilt, zoom
   - CT timeline with action CT cost preview and resorting
   - Four jobs across two sides; actions preview damage/hit
   - EXP/JP rewards, portraits rail, controls always visible
*/

(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  // Resize canvas for crisp rendering
  function fitCanvas() {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.clientHeight || canvas.height;
    canvas.width = Math.floor(w * DPR);
    canvas.height = Math.floor(h * DPR);
  }
  fitCanvas();
  window.addEventListener('resize', fitCanvas);

  // UI Elements
  const commandPanel = document.getElementById('commandPanel');
  const statusPanel = document.getElementById('statusPanel');
  const toast = document.getElementById('toast');
  const inspectPanel = document.getElementById('inspectPanel');

  // Turn rail
  const rail = document.createElement('div');
  rail.className = 'rail';
  document.getElementById('overlay').appendChild(rail);

  // Math helpers
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const rnd = (min, max) => Math.random() * (max - min) + min;
  const irnd = (min, max) => (min + Math.floor(Math.random() * (max - min + 1)));

  // Camera and Iso projection
  const camera = {
    rot: 0,             // 0..3 => 0,90,180,270
    tilt: 0.82,         // 0.7..1.0 visual foreshortening
    zoom: 1.0,          // 0.8..1.6
    panX: 0,
    panY: 0,
    focus: { x: 8, y: 8 }, // center tile
  };
  camera.rotAngle = camera.rot * (Math.PI/2);
  camera.rotTarget = camera.rotAngle;

  // Tile metrics
  const TILE_W = 64;  // base width of a flat diamond
  const TILE_H = 32;  // base height of a flat diamond
  const H_STEP = 16;  // pixel vertical for 0.5h (height unit is 0.5)

  function rotCoord(x, y, rot) {
    // rotate 0..3 times (90° steps) around origin
    switch (rot & 3) {
      case 0: return { x, y };
      case 1: return { x: y, y: -x };
      case 2: return { x: -x, y: -y };
      case 3: return { x: -y, y: x };
    }
  }
  function rotCoordAngle(x, y, ang) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return { x: x * ca - y * sa, y: x * sa + y * ca };
  }

  function worldToScreen(wx, wy, hz) {
    // rotate in world grid space around camera focus
    const fx = camera.focus.x, fy = camera.focus.y;
    const rx = wx - fx, ry = wy - fy;
    const r = rotCoordAngle(rx, ry, camera.rotAngle);

    const isoX = (r.x - r.y) * (TILE_W / 2);
    const isoY = (r.x + r.y) * (TILE_H / 2) * camera.tilt;
    const elev = -hz * H_STEP; // height visually up

    const cx = (canvas.width / 2) + camera.panX;
    const cy = (canvas.height / 2) + camera.panY;
    return {
      x: Math.round(cx + isoX * camera.zoom),
      y: Math.round(cy + (isoY + elev) * camera.zoom),
    };
  }

  function screenToGrid(sx, sy, guessZ = 0) {
    // approximate inverse of worldToScreen for cursor selection
    const cx = (canvas.width / 2) + camera.panX;
    const cy = (canvas.height / 2) + camera.panY;
    const x = (sx - cx) / camera.zoom;
    const y = (sy - cy + guessZ * H_STEP) / camera.zoom;
    // Undo tilt and iso
    const ry = y / (TILE_H / 2) / camera.tilt;
    const rx = x / (TILE_W / 2);
    const rX = (ry + rx) / 2;
    const rY = (ry - rx) / 2;
    // Unrotate (approx inverse using discrete rot for selection stability)
    let ur;
    switch (camera.rot & 3) {
      case 0: ur = { x: rX, y: rY }; break;
      case 1: ur = { x: -rY, y: rX }; break;
      case 2: ur = { x: -rX, y: -rY }; break;
      case 3: ur = { x: rY, y: -rX }; break;
    }
    return { x: Math.round(ur.x + camera.focus.x), y: Math.round(ur.y + camera.focus.y) };
  }

  // Map generation: town/fort theme
  const map = createTownFortMap(16, 16);

  // Jobs and Abilities
  const JOBS = createJobs();

  // Units
  const units = createUnits(map);
  const idUnit = new Map(units.map(u => [u.id, u]));

  // Game State Machine
  const game = {
    map, units, idUnit,
    cursor: { x: 8, y: 8 },
    phase: 'idle', // idle -> unit_start -> command -> targeting -> resolving
    activeId: null,
    selectedCmd: 0,
    targeting: null, // { ability, tiles:[], targets:[], origin:{x,y}, cursor:{x,y}, preview:{} }
    uiHints: true,
    time: 0,
  };

  // Initialize CT randomization for variety
  for (const u of units) u.ct = irnd(0, 80);

  // Main Loop
  let lastTs = 0;
  function loop(ts) {
    const dt = Math.min(33, ts - lastTs || 16);
    lastTs = ts;
    update(dt);
    render();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // Update
  function update(dt) {
    // Movement animation progression
    if (game.anim && game.anim.kind === 'move') {
      const anim = game.anim;
      anim.t += (dt/1000) * anim.speed;
      while (anim.t >= 1 && anim.index < anim.path.length - 1) {
        anim.t -= 1;
        anim.index++;
      }
      const u = idUnit.get(anim.unitId);
      if (u) u.anim = { ...anim };
      if (anim.index >= anim.path.length - 1) {
        if (u) { const last = anim.path[anim.path.length - 1]; u.pos.x = last.x; u.pos.y = last.y; u.anim = null; }
        game.anim = null;
        // Allow further command (move then act)
        if (game.phase === 'anim') game.phase = 'unit_start';
      }
    }
    // Smooth camera rotation toward target
    const diff = ((camera.rotTarget - camera.rotAngle + Math.PI*3) % (Math.PI*2)) - Math.PI;
    const speed = 6.5; // rad/s
    const step = Math.sign(diff) * Math.min(Math.abs(diff), speed * (dt/1000));
    camera.rotAngle += step;
    // Process CT to find next actor if idle
    if (game.phase === 'idle') {
      // Advance CT to the next actor reaching 100
      const speeds = units.filter(u => u.alive !== false);
      if (speeds.length === 0) return;
      const timeTo100 = speeds.map(u => (u.ct >= 100 ? 0 : (100 - u.ct) / Math.max(1, u.stats.spd)));
      const minT = Math.min(...timeTo100);
      for (const u of speeds) u.ct += u.stats.spd * minT;
      const next = speeds.find(u => u.ct >= 100);
      if (next) {
        game.activeId = next.id;
        game.phase = 'unit_start';
        game.selectedCmd = 0;
        game.cursor.x = next.pos.x; game.cursor.y = next.pos.y;
        showToast(`${next.name}'s turn`);
        // Simple AI for Red team
        if (next.team === 'Red') {
          setTimeout(() => aiAct(next), 250);
        }
      }
    }
  }

  // Rendering
  function render() {
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    drawSkyBackdrop();
    drawMap();
    drawHighlightsAndPreviews();
    drawUnits();
    drawCursor();
    drawUI();
    ctx.restore();
  }

  function drawSkyBackdrop() {
    const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
    g.addColorStop(0, '#0c1122');
    g.addColorStop(1, '#0a0f1d');
    ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawMap() {
    // Determine draw order: iterate by sum of (x+y), respecting rotation
    const drawOrder = [];
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        drawOrder.push({ x, y, s: x + y });
      }
    }
    // Sort to draw back-to-front with rotation considered by y/x swap
    const ang = camera.rotAngle;
    drawOrder.sort((a, b) => {
      const A = rotCoordAngle(a.x - camera.focus.x, a.y - camera.focus.y, ang);
      const B = rotCoordAngle(b.x - camera.focus.x, b.y - camera.focus.y, ang);
      const da = (A.x + A.y), db = (B.x + B.y);
      if (da !== db) return da - db;
      return (A.x - A.y) - (B.x - B.y);
    });

    for (const t of drawOrder) {
      const tile = map.tiles[t.y][t.x];
      drawTile(t.x, t.y, tile);
    }
  }

  function drawTile(x, y, tile) {
    const h = tile.h; // multiples of 0.5
    const base = worldToScreen(x, y, 0);
    // Draw stacked walls for height
    const levels = Math.round(h / 0.5);
    for (let i = 0; i < levels; i++) {
      const z = (i + 1) * 0.5;
      const top = worldToScreen(x, y, z);
      const bot = worldToScreen(x, y, z - 0.5);
      const colorFace = tint(tile.color, -10 - i * 2);
      const colorSide = tint(tile.color, -25 - i * 3);
      // Left/right walls (simple)
      const hw = (TILE_W / 2) * camera.zoom;
      const hh = (TILE_H / 2) * camera.zoom * camera.tilt;
      const hs = H_STEP * camera.zoom;
      ctx.beginPath();
      // right face
      ctx.moveTo(bot.x, bot.y);
      ctx.lineTo(bot.x + hw, bot.y + hh);
      ctx.lineTo(top.x + hw, top.y + hh);
      ctx.lineTo(top.x, top.y);
      ctx.closePath();
      ctx.fillStyle = colorFace; ctx.fill();
      // left face
      ctx.beginPath();
      ctx.moveTo(bot.x, bot.y);
      ctx.lineTo(bot.x - hw, bot.y + hh);
      ctx.lineTo(top.x - hw, top.y + hh);
      ctx.lineTo(top.x, top.y);
      ctx.closePath();
      ctx.fillStyle = colorSide; ctx.fill();
    }
    // Top diamond
    const top = worldToScreen(x, y, h);
    const hw = (TILE_W / 2) * camera.zoom;
    const hh = (TILE_H / 2) * camera.zoom * camera.tilt;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y - hh);
    ctx.lineTo(top.x + hw, top.y);
    ctx.lineTo(top.x, top.y + hh);
    ctx.lineTo(top.x - hw, top.y);
    ctx.closePath();
    ctx.fillStyle = tile.roof ? tint(tile.color, 12) : tile.color;
    ctx.fill();

    // Details: windows or crenellations
    if (tile.roof && Math.random() < 0.001) { /* sparkle */ }
  }

  function drawUnits() {
    const ordered = [...units].sort((a, b) => (a.pos.x + a.pos.y + a.pos.z) - (b.pos.x + b.pos.y + b.pos.z));
    for (const u of ordered) {
      if (u.alive === false) continue;
      const baseH = map.tiles[u.pos.y][u.pos.x].h + 0.001;
      let p = worldToScreen(u.pos.x, u.pos.y, baseH);
      if (u.anim && u.anim.kind === 'move') {
        const i = u.anim.index;
        const a = u.anim.path[i];
        const b = u.anim.path[Math.min(i+1, u.anim.path.length-1)];
        const pa = worldToScreen(a.x, a.y, map.tiles[a.y][a.x].h + 0.001);
        const pb = worldToScreen(b.x, b.y, map.tiles[b.y][b.x].h + 0.001);
        const t = u.anim.t;
        p = { x: lerp(pa.x, pb.x, t), y: lerp(pa.y, pb.y, t) };
      }
      // Shadow
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 6, 10 * camera.zoom, 5 * camera.zoom, 0, 0, Math.PI * 2); ctx.fill();
      // Body (stylized)
      drawActorSprite(p.x, p.y - 12 * camera.zoom, u);
      // Name label
      ctx.font = `${Math.round(12 * camera.zoom)}px sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3;
      ctx.strokeText(u.name, p.x, p.y - 38 * camera.zoom);
      ctx.fillText(u.name, p.x, p.y - 38 * camera.zoom);
      // HP bar
      const width = 34 * camera.zoom, height = 6 * camera.zoom;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(p.x - width / 2, p.y - 34 * camera.zoom, width, height);
      ctx.fillStyle = u.team === 'Blue' ? 'rgba(79,195,247,0.9)' : 'rgba(255,107,107,0.9)';
      ctx.fillRect(p.x - width / 2, p.y - 34 * camera.zoom, width * (u.stats.hp / u.stats.maxhp), height);
    }
  }

  function drawActorSprite(x, y, u) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(camera.zoom, camera.zoom);
    // Base
    ctx.fillStyle = u.color;
    ctx.strokeStyle = '#00000090';
    ctx.lineWidth = 2;
    // Different shapes by job
    const job = u.job;
    if (job === 'Knight') {
      // bulky torso + shield
      roundedRect(-10, -16, 20, 28, 6, u.color);
      ctx.fillStyle = tint(u.color, -20); ctx.fillRect(-4, -20, 8, 6); // helmet
      ctx.fillStyle = '#c0d0ff'; ctx.beginPath(); ctx.arc(12, -4, 6, 0, Math.PI * 2); ctx.fill();
    } else if (job === 'Archer') {
      roundedRect(-9, -16, 18, 26, 6, u.color);
      ctx.strokeStyle = '#cbb089'; ctx.beginPath(); ctx.arc(10, -2, 8, -Math.PI/2, Math.PI/2); ctx.stroke();
    } else if (job === 'Mage') {
      roundedRect(-11, -16, 22, 26, 10, u.color);
      ctx.fillStyle = tint(u.color, -25); ctx.beginPath(); ctx.moveTo(-11, -16); ctx.lineTo(11, -16); ctx.lineTo(0, -26); ctx.closePath(); ctx.fill();
    } else if (job === 'Priest') {
      roundedRect(-10, -16, 20, 26, 8, u.color);
      ctx.fillStyle = '#ffd166'; ctx.fillRect(-2, -10, 4, 12);
      ctx.fillRect(-6, -5, 12, 4);
    } else {
      roundedRect(-10, -16, 20, 26, 6, u.color);
    }
    // Face
    drawFace(0, -6, u.face || generateFace(u.name));
    ctx.restore();
  }

  function roundedRect(x, y, w, h, r, fill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
    ctx.strokeStyle = '#00000050'; ctx.stroke();
  }

  function drawHighlightsAndPreviews() {
    const cur = game.cursor;
    // Hover tile highlight
    if (insideMap(cur.x, cur.y)) {
      const top = worldToScreen(cur.x, cur.y, map.tiles[cur.y][cur.x].h + 0.01);
      const hw = (TILE_W / 2) * camera.zoom;
      const hh = (TILE_H / 2) * camera.zoom * camera.tilt;
      ctx.beginPath();
      ctx.moveTo(top.x, top.y - hh);
      ctx.lineTo(top.x + hw, top.y);
      ctx.lineTo(top.x, top.y + hh);
      ctx.lineTo(top.x - hw, top.y);
      ctx.closePath();
      ctx.strokeStyle = '#00e0ffcc'; ctx.lineWidth = 2; ctx.stroke();
    }

    // Targeting preview overlays
    if (game.phase === 'targeting' && game.targeting) {
      const t = game.targeting;
      const tiles = computeAbilityTiles(t.origin, t.ability);
      const targets = [];
      for (const tile of tiles) {
        // overlay tiles
        const top = worldToScreen(tile.x, tile.y, map.tiles[tile.y][tile.x].h + 0.02);
        const hw = (TILE_W / 2) * camera.zoom;
        const hh = (TILE_H / 2) * camera.zoom * camera.tilt;
        ctx.beginPath(); ctx.moveTo(top.x, top.y - hh); ctx.lineTo(top.x + hw, top.y); ctx.lineTo(top.x, top.y + hh); ctx.lineTo(top.x - hw, top.y); ctx.closePath();
        ctx.fillStyle = t.ability.kind === 'heal' ? 'rgba(100,255,160,0.25)' : 'rgba(255,120,120,0.25)';
        ctx.fill();
      }
      // Current cursor target + effect numbers
      const aff = computeAbilityEffectAtCursor(t);
      for (const a of aff) {
        const u = idUnit.get(a.id);
        if (!u) continue;
        const p = worldToScreen(u.pos.x, u.pos.y, map.tiles[u.pos.y][u.pos.x].h + 0.8);
        ctx.font = `${Math.round(14 * camera.zoom)}px sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = a.hit >= 1 ? '#ffffff' : '#ffc36b';
        const text = a.kind === 'heal' ? `+${a.amount} (${Math.round(a.hit*100)}%)` : `-${a.amount} (${Math.round(a.hit*100)}%)`;
        ctx.fillText(text, p.x, p.y - 20 * camera.zoom);
      }
    }
  }

  function drawCursor() {
    const cur = game.cursor;
    if (!insideMap(cur.x, cur.y)) return;
    const tile = map.tiles[cur.y][cur.x];
    const p = worldToScreen(cur.x, cur.y, tile.h + 0.8);
    ctx.strokeStyle = '#6ac6ffcc';
    ctx.lineWidth = 2; ctx.strokeRect(p.x - 10 * camera.zoom, p.y - 26 * camera.zoom, 20 * camera.zoom, 24 * camera.zoom);
  }

  function drawUI() {
    // Command panel for active unit
    renderCommandPanel();
    // Status panel for active unit
    renderStatusPanel();
    // Portrait rail
    renderTurnRail();
    // Inspect panel
    renderInspectPanel();
  }

  function renderInspectPanel() {
    const cx = game.cursor.x, cy = game.cursor.y;
    if (!insideMap(cx, cy)) { inspectPanel.innerHTML = ''; return; }
    const tile = map.tiles[cy][cx];
    const unit = units.find(u => u.alive !== false && u.pos.x === cx && u.pos.y === cy);
    let html = `<div class="title">Inspect (${cx},${cy})</div>`;
    html += `<div class="line"><div>Height</div><div>${tile.h.toFixed(1)}h</div></div>`;
    html += `<div class="line"><div>Passable</div><div>${tile.pass ? 'Yes' : 'No'}</div></div>`;
    if (unit) {
      html += `<div class="line"><div>Unit</div><div>${unit.name} — ${unit.job} (${unit.team})</div></div>`;
      html += `<div class="line"><div>HP</div><div>${unit.stats.hp}/${unit.stats.maxhp}</div></div>`;
    }
    inspectPanel.innerHTML = html;
  }

  function renderCommandPanel() {
    const u = idUnit.get(game.activeId);
    const cmds = computeAvailableCommands(u);
    let html = `<div class="title">Commands${u ? ` — ${u.name} (${u.job})` : ''}</div>`;
    cmds.forEach((c, i) => {
      html += `<div class="cmd ${i === game.selectedCmd ? 'active' : ''}">`+
              `<div><span class="key">${i+1}</span> ${c.name}</div>`+
              `<div>${c.detail || ''}</div>`+
              `</div>`;
    });
    commandPanel.innerHTML = html;
  }

  function renderStatusPanel() {
    const u = idUnit.get(game.activeId);
    if (!u) { statusPanel.innerHTML = ''; return; }
    const hpPct = (100 * u.stats.hp / u.stats.maxhp) | 0;
    let html = '';
    html += `<div class="line"><div><b>${u.name}</b> — ${u.job} (${u.team})</div><div>Lv ${u.stats.lvl}  CT ${u.ct.toFixed(0)}</div></div>`;
    html += `<div class="line"><div style="flex:1">HP</div><div class="bar" style="flex:4"><span style="width:${hpPct}%"></span></div><div>${u.stats.hp}/${u.stats.maxhp}</div></div>`;
    html += `<div class="line"><div>EXP</div><div>${u.stats.exp|0}/100</div><div>JP</div><div>${u.stats.jp|0}</div></div>`;
    html += `<div class="line" style="color:var(--muted)">SPD ${u.stats.spd}  MOV ${u.stats.mov}  JMP ${u.stats.jump}  ATK ${u.stats.atk}  MAG ${u.stats.mag}</div>`;
    statusPanel.innerHTML = html;
  }

  function renderTurnRail() {
    const forecast = predictTimeline(units, 10, game);
    let html = '';
    for (const f of forecast) {
      const u = idUnit.get(f.id);
      if (!u) continue;
      const bg = u.team === 'Blue' ? 'linear-gradient(135deg,#1e4a6b,#2f6c9c)' : 'linear-gradient(135deg,#6b1e1e,#9c2f2f)';
      html += `<div class="entry">`+
              `<div class="portrait" style="background:${bg};border-color:${u.team==='Blue'?'#4fc3f7aa':'#ff6b6baa'}"></div>`+
              `<div class="meta"><div class="name">${u.name}</div><div class="ct">CT ${f.ct.toFixed(0)}${f.note?(' — '+f.note):''}</div></div>`+
              `</div>`;
    }
    rail.innerHTML = html;
  }

  // Commands
  function computeAvailableCommands(u) {
    if (!u) return [ { name: '—', detail:'' } ];
    const base = [
      { key:'move', name:'Move', detail:`Up to ${u.stats.mov}` },
      { key:'attack', name:'Attack', detail:`Rng 1, CT +${JOBS[u.job].attack.ct}` },
    ];
    for (const a of u.abilities) base.push({ key:'ability', ability:a, name:a.name, detail:`Rng ${a.range} AOE ${a.aoe||0} CT +${a.ct}`});
    base.push({ key:'wait', name:'Wait', detail:'End turn' });
    return base;
  }

  // Input
  const keys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.key.toLowerCase());
    handleKey(e.key.toLowerCase());
  });
  window.addEventListener('keyup', (e) => { keys.delete(e.key.toLowerCase()); });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * DPR;
    const y = (e.clientY - rect.top) * DPR;
    const g = screenToGrid(x, y, 0);
    if (insideMap(g.x, g.y)) {
      game.cursor.x = g.x; game.cursor.y = g.y;
    }
  });
  canvas.addEventListener('click', () => { handleKey('enter'); });

  function handleKey(k) {
    const u = idUnit.get(game.activeId);
    switch (k) {
      // Camera
      case 'q': camera.rot = (camera.rot + 3) & 3; camera.rotTarget = camera.rot * (Math.PI/2); break;
      case 'e': camera.rot = (camera.rot + 1) & 3; camera.rotTarget = camera.rot * (Math.PI/2); break;
      case 'r': camera.tilt = clamp(camera.tilt + 0.05, 0.7, 1.0); break;
      case 'f': camera.tilt = clamp(camera.tilt - 0.05, 0.7, 1.0); break;
      case 'z': camera.zoom = clamp(camera.zoom + 0.1, 0.8, 1.6); break;
      case 'x': camera.zoom = clamp(camera.zoom - 0.1, 0.8, 1.6); break;
      case 'h': game.uiHints = !game.uiHints; document.getElementById('controls').classList.toggle('hidden', !game.uiHints); break;
      case '0': autoBattleActiveUnit(); break;

      // Cursor
      case 'arrowleft': moveCursor(-1, 0); break;
      case 'arrowright': moveCursor(1, 0); break;
      case 'arrowup': moveCursor(0, -1); break;
      case 'arrowdown': moveCursor(0, 1); break;

      // Confirm / Cancel
      case 'enter':
      case ' ': confirmAction(); break;
      case 'escape':
      case 'backspace': cancelAction(); break;

      // Commands shortcuts 1..9
      case '1': selectCommand(0); break;
      case '2': selectCommand(1); break;
      case '3': selectCommand(2); break;
      case '4': selectCommand(3); break;
      case '5': selectCommand(4); break;
    }
  }

  function autoBattleActiveUnit() {
    const u = idUnit.get(game.activeId);
    if (!u) return;
    if (u.team !== 'Blue') return;
    aiAct(u);
  }

  function moveCursor(dx, dy) {
    const r = rotIndexCoord(dx, dy, camera.rot);
    const nx = clamp(game.cursor.x + r.x, 0, map.w - 1);
    const ny = clamp(game.cursor.y + r.y, 0, map.h - 1);
    game.cursor.x = nx; game.cursor.y = ny;
  }

  function selectCommand(idx) {
    if (game.phase !== 'unit_start' && game.phase !== 'command') return;
    const u = idUnit.get(game.activeId);
    const cmds = computeAvailableCommands(u);
    if (idx < 0 || idx >= cmds.length) return;
    game.phase = 'command';
    game.selectedCmd = idx;
    const c = cmds[idx];
    if (c.key === 'move') {
      startTargeting({ ability: { name:'Move', key:'move', range:u.stats.mov, aoe:0, kind:'move', ct: 10 }, origin: { x: u.pos.x, y: u.pos.y } });
    } else if (c.key === 'attack') {
      startTargeting({ ability: JOBS[u.job].attack, origin: { x: u.pos.x, y: u.pos.y } });
    } else if (c.key === 'ability') {
      startTargeting({ ability: c.ability, origin: { x: u.pos.x, y: u.pos.y } });
    } else if (c.key === 'wait') {
      endTurn(u, 10); // small CT cost to wait
    }
  }

  function startTargeting(targeting) {
    game.phase = 'targeting';
    game.targeting = { ...targeting, cursor: { x: game.cursor.x, y: game.cursor.y } };
  }

  function cancelAction() {
    if (game.phase === 'targeting') {
      game.phase = 'unit_start';
      game.targeting = null;
    } else if (game.phase === 'command') {
      game.phase = 'unit_start';
    } else if (game.phase === 'unit_start') {
      // do nothing
    }
  }

  function confirmAction() {
    const u = idUnit.get(game.activeId);
    if (!u) return;
    if (game.phase === 'unit_start') { game.phase = 'command'; return; }
    if (game.phase !== 'targeting' || !game.targeting) return;
    const t = game.targeting;
    if (t.ability.key === 'move') {
      // Move unit to cursor if in range and passable
      const path = findPath(u.pos, { x: game.cursor.x, y: game.cursor.y }, u.stats.mov, u.stats.jump);
      if (path) {
        // animate movement
        u.anim = { kind:'move', path, index:0, t:0, speed:6.0 };
        game.anim = { kind:'move', unitId:u.id, path, index:0, t:0, speed:6.0 };
        awardJP(u, 5);
        showToast(`${u.name} moved.`);
        game.phase = 'anim';
        game.targeting = null;
        return;
      } else {
        showToast('Invalid move');
        return;
      }
    }
    // Resolve offensive/heal abilities
    const affected = computeAbilityEffectAtCursor({ ...t, cursor: { x: game.cursor.x, y: game.cursor.y } });
    if (affected.length === 0) { showToast('No valid targets'); return; }
    let exp = 0, jp = 8;
    for (const a of affected) {
      const target = idUnit.get(a.id);
      const hitRoll = Math.random();
      if (hitRoll <= a.hit) {
        if (a.kind === 'heal') {
          const before = target.stats.hp;
          target.stats.hp = clamp(target.stats.hp + a.amount, 0, target.stats.maxhp);
          exp += Math.min(15, Math.round((target.stats.hp - before) * 0.5));
        } else {
          target.stats.hp = clamp(target.stats.hp - a.amount, 0, target.stats.maxhp);
          exp += Math.min(30, Math.round(a.amount * 0.5));
          if (target.stats.hp <= 0) { target.alive = false; showToast(`${target.name} is KO!`); exp += 20; }
        }
      }
    }
    // Face toward action center
    setFacingTowards(u, { x: game.cursor.x, y: game.cursor.y });
    awardEXP(u, Math.max(10, exp));
    awardJP(u, jp);
    endTurn(u, t.ability.ct);
    game.targeting = null;
  }

  function endTurn(u, ctCost) {
    u.ct = Math.max(0, 0 - (ctCost || 0)); // push back in timeline; negative means extra time
    game.phase = 'idle';
    game.activeId = null;
  }

  function awardEXP(u, amount) {
    u.stats.exp += amount;
    if (u.stats.exp >= 100) { u.stats.exp -= 100; u.stats.lvl += 1; u.stats.maxhp += 6; u.stats.hp = u.stats.maxhp; u.stats.atk += 1; u.stats.mag += 1; u.stats.spd += (u.stats.lvl % 2 === 0) ? 1 : 0; showToast(`${u.name} leveled up!`); }
  }
  function awardJP(u, amount) { u.stats.jp += amount; }

  // Ability calculations and previews
  function computeAbilityTiles(origin, ability) {
    const tiles = [];
    const R = ability.range;
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
      const d = gridDist(origin, { x, y });
      if (d <= R) tiles.push({ x, y });
    }
    return tiles;
  }

  function computeAbilityEffectAtCursor(t) {
    const aoe = t.ability.aoe || 0;
    const tiles = [];
    for (let y = 0; y < map.h; y++) for (let x = 0; x < map.w; x++) {
      const d = gridDist(t.cursor, { x, y });
      if (d <= aoe) tiles.push({ x, y });
    }
    const list = [];
    for (const u of units) {
      if (u.alive === false) continue;
      if (tiles.some(tt => tt.x === u.pos.x && tt.y === u.pos.y)) {
        const res = calcEffect(t.ability, idUnit.get(game.activeId), u, t.cursor, t.origin);
        if (res) list.push(res);
      }
    }
    return list;
  }

  function calcEffect(ability, user, target, centerTile, originTile) {
    const from = originTile || user.pos;
    const dist = gridDist(from, centerTile);
    if (dist > ability.range) return null;
    // Target side rules: damage enemies, heal allies
    if (ability.kind === 'heal' && user.team !== target.team) return null;
    if (ability.kind !== 'heal' && user.team === target.team) return null;
    // Height modifier
    const uh = map.tiles[from.y][from.x].h;
    const th = map.tiles[target.pos.y][target.pos.x].h;
    const hDiff = uh - th;
    let baseHit = (ability.baseHit != null ? ability.baseHit : 0.75);
    baseHit += clamp((hDiff) * 0.05, -0.2, 0.2);
    let amount = 0; let kind = ability.kind || 'damage';
    if (kind === 'heal') amount = Math.round(ability.power + user.stats.mag * 1.2);
    else amount = Math.round(ability.power + user.stats.atk * 1.1);
    // LoS & cover for ranged physical
    if (kind !== 'heal' && ability.range > 1 && ability.reqLoS !== false) {
      const los = hasLineOfSight(from, target.pos);
      if (!los) return { id: target.id, amount, hit: 0, kind };
      baseHit += coverPenalty(from, target.pos);
    }
    // Facing bonuses
    const facingMod = facingModifier({ pos: from, facing: user.facing, team: user.team }, target);
    baseHit += facingMod.hit;
    amount = Math.round(amount * (1 + facingMod.dmg));
    baseHit = clamp(baseHit, 0.05, 0.98);
    // Ranged falloff for Archer attack
    if (ability.key === 'attack' && user.job === 'Archer') {
      const d = gridDist(from, target.pos);
      amount = Math.max(1, Math.round(amount * (1 - Math.max(0, d - 3) * 0.1)));
    }
    return { id: target.id, amount, hit: baseHit, kind };
  }

  // Timeline forecast
  function predictTimeline(unitList, count, gameState) {
    const unitsAlive = unitList.filter(u => u.alive !== false);
    const snapshot = unitsAlive.map(u => ({ id:u.id, ct:u.ct, spd:u.stats.spd }));
    const result = [];
    // If currently previewing an action, apply its CT cost to active unit after it acts
    const active = gameState.activeId ? idUnit.get(gameState.activeId) : null;
    const ability = (gameState.phase === 'targeting' && gameState.targeting) ? gameState.targeting.ability : null;

    for (let k = 0; k < count; k++) {
      // Advance to next reaching 100
      const minTime = Math.min(...snapshot.map(s => s.ct >= 100 ? 0 : (100 - s.ct) / Math.max(1, s.spd)));
      for (const s of snapshot) s.ct += s.spd * minTime;
      // Pick next
      let nextIndex = snapshot.findIndex(s => s.ct >= 100);
      if (nextIndex === -1) break;
      const s = snapshot[nextIndex];
      const note = (active && s.id === active.id && ability) ? `${ability.name}` : '';
      result.push({ id: s.id, ct: s.ct, note });
      // Apply post-act CT cost
      const ctCost = (active && s.id === active.id && ability) ? (ability.ct || 0) : 0;
      s.ct = Math.max(0, 0 - ctCost);
    }
    return result;
  }

  // Pathfinding (simple BFS with height/jump constraints)
  function findPath(from, to, range, jump) {
    if (!insideMap(to.x, to.y)) return null;
    // Disallow landing on occupied tile (unless it's the start)
    const occupied = new Set(units.filter(u=>u.alive!==false).map(u=>`${u.pos.x},${u.pos.y}`));
    occupied.delete(`${from.x},${from.y}`);
    const start = `${from.x},${from.y}`;
    const goal = `${to.x},${to.y}`;
    const q = [start];
    const prev = new Map();
    const dist = new Map([[start, 0]]);
    while (q.length) {
      const cur = q.shift();
      if (cur === goal) break;
      const [cx, cy] = cur.split(',').map(Number);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!insideMap(nx, ny)) continue;
        if (!map.tiles[ny][nx].pass) continue;
        if (occupied.has(`${nx},${ny}`)) continue;
        const h1 = map.tiles[cy][cx].h, h2 = map.tiles[ny][nx].h;
        if (Math.abs(h2 - h1) > jump) continue;
        const key = `${nx},${ny}`;
        const nd = (dist.get(cur) || 0) + 1;
        if (nd > range) continue;
        if (!dist.has(key)) { dist.set(key, nd); prev.set(key, cur); q.push(key); }
      }
    }
    if (!prev.has(goal) && start !== goal) return null;
    // reconstruct path
    const path = [];
    let cur = goal;
    path.push(strToPos(cur));
    while (cur !== start) {
      cur = prev.get(cur);
      if (!cur) break;
      path.push(strToPos(cur));
    }
    path.reverse();
    return path;
  }

  // Utilities
  function gridDist(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }
  function insideMap(x, y) { return x >= 0 && y >= 0 && x < map.w && y < map.h; }
  function tint(color, amount) {
    // color as hex #rrggbb, adjust brightness
    const c = parseInt(color.slice(1), 16);
    let r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
    r = clamp(Math.round(r + amount), 0, 255);
    g = clamp(Math.round(g + amount), 0, 255);
    b = clamp(Math.round(b + amount), 0, 255);
    return `#${(r<<16|g<<8|b).toString(16).padStart(6,'0')}`;
  }
  function setFacingTowards(u, target) {
    const dx = target.x - u.pos.x, dy = target.y - u.pos.y;
    if (Math.abs(dx) > Math.abs(dy)) u.facing = dx > 0 ? 1 : 3; else if (Math.abs(dy) > 0) u.facing = dy > 0 ? 2 : 0;
  }
  function showToast(text) {
    toast.textContent = text;
    toast.style.opacity = 1;
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => { toast.style.opacity = 0; }, 1400);
  }
  function strToPos(s){ const [x,y] = s.split(',').map(Number); return { x, y }; }

  // Line of sight and cover
  function bresenham(x0, y0, x1, y1) {
    const points = [];
    let dx = Math.abs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    let x = x0, y = y0;
    while (true) {
      points.push({ x, y });
      if (x === x1 && y === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return points;
  }
  function hasLineOfSight(a, b) {
    if (gridDist(a,b) <= 1) return true;
    const points = bresenham(a.x, a.y, b.x, b.y);
    const ah = map.tiles[a.y][a.x].h;
    const bh = map.tiles[b.y][b.x].h;
    const blockH = Math.min(ah, bh) + 0.5;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      const t = map.tiles[p.y][p.x];
      if (!t.pass || t.h > blockH) return false;
    }
    return true;
  }
  function coverPenalty(a, b) {
    let pen = 0;
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    const fx = b.x - dx, fy = b.y - dy;
    if (insideMap(fx, fy)) {
      const t = map.tiles[fy][fx];
      if (!t.pass || t.h >= map.tiles[b.y][b.x].h) pen -= 0.2;
    }
    const unitBlock = units.some(u => u.alive!==false && u.pos.x===fx && u.pos.y===fy);
    if (unitBlock) pen -= 0.1;
    return pen;
  }

  // Facing utilities
  function rotIndexCoord(x, y, rot) {
    switch (rot & 3) {
      case 0: return { x, y };
      case 1: return { x: y, y: -x };
      case 2: return { x: -x, y: -y };
      case 3: return { x: -y, y: x };
    }
  }
  function facingModifier(attacker, target) {
    const dx = Math.sign(attacker.pos.x - target.pos.x);
    const dy = Math.sign(attacker.pos.y - target.pos.y);
    const v = rotIndexCoord(dx, dy, (4 - (target.facing||0)) & 3);
    if (v.y > 0 && v.x === 0) return { hit: 0.25, dmg: 0.25 };
    if (v.y === 0 && v.x !== 0) return { hit: 0.10, dmg: 0.10 };
    return { hit: 0, dmg: 0 };
  }

  // Seeded face generation
  function seedFromString(str){
    let h = 2166136261 >>> 0;
    for (let i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function srand(seed){ let a = seed>>>0; return function(){ a = (a*1664525 + 1013904223)>>>0; return (a>>>0)/4294967296; }; }
  function pick(rnd, arr){ return arr[Math.floor(rnd()*arr.length)]; }
  function generateFace(name){
    const r = srand(seedFromString(name));
    const gender = r() < 0.5 ? 'F' : 'M';
    const skin = pick(r, ['#ffe0c0','#ffd0a0','#eec29a','#d6a67e','#b98565']);
    const eye = pick(r, ['#3a3a3a','#2b4a6f','#4a2b6f','#2b6f48']);
    const hair = pick(r, ['#2e1b0f','#5a3826','#7b4b2a','#cfa66b','#131722','#6b2f2f']);
    const style = Math.floor(r()*5); // 0:short,1:long,2:spiky,3:bangs,4:cap
    const brows = Math.floor(r()*3); // 0..2
    const accessory = r()<0.15 ? (gender==='M'?'beard':'ribbon') : (r()<0.15?'glasses':null);
    return { gender, skin, eye, hair, style, brows, accessory };
  }
  function drawFace(x,y,face){
    ctx.save();
    ctx.translate(x,y);
    // head
    ctx.fillStyle = face.skin; ctx.beginPath(); ctx.arc(0,0,3,0,Math.PI*2); ctx.fill();
    // hair styles
    ctx.fillStyle = face.hair;
    if (face.style===0){ ctx.beginPath(); ctx.arc(0,-1,4,Math.PI,0); ctx.fill(); }
    else if (face.style===1){ ctx.fillRect(-3,-2,6,2); }
    else if (face.style===2){ for(let i=-3;i<=3;i+=2){ ctx.beginPath(); ctx.moveTo(i,-3); ctx.lineTo(i+1,-5); ctx.lineTo(i+2,-3); ctx.fill(); } }
    else if (face.style===3){ ctx.fillRect(-3,-3,6,1); }
    else if (face.style===4){ ctx.fillStyle = '#2a2a2a'; ctx.fillRect(-4,-4,8,2); }
    // eyes
    ctx.fillStyle = face.eye; ctx.fillRect(-2,-1,1,1); ctx.fillRect(1,-1,1,1);
    // brows
    ctx.fillStyle = '#2a1a0a'; if(face.brows>=1){ ctx.fillRect(-2,-2,2,1); ctx.fillRect(0,-2,2,1); }
    if(face.brows===2){ ctx.fillRect(-2,-3,2,1); ctx.fillRect(0,-3,2,1); }
    // accessory
    if (face.accessory==='glasses'){ ctx.strokeStyle='#c0d0ff'; ctx.lineWidth=0.6; ctx.strokeRect(-3,-2,2,2); ctx.strokeRect(1,-2,2,2); ctx.beginPath(); ctx.moveTo(-1,-1); ctx.lineTo(1,-1); ctx.stroke(); }
    if (face.accessory==='ribbon'){ ctx.fillStyle='#ff6bb6'; ctx.fillRect(-1,-4,2,1); }
    if (face.accessory==='beard'){ ctx.fillStyle='#5a3826'; ctx.fillRect(-2,1,4,1); }
    ctx.restore();
  }

  // Data setup: Map, Jobs, Units
  function createTownFortMap(w, h) {
    const tiles = Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => ({ h: 0, pass: true, color: '#2a3b57', roof: false })));

    // Base plateau and streets
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      tiles[y][x].h = 0.5 * (x%2===0?1:0); // gentle offsets
      tiles[y][x].color = (x + y) % 2 ? '#2a3b57' : '#2d4364';
    }
    // Fort walls
    for (let x = 2; x < w - 2; x++) {
      tiles[3][x].h = 2.5; tiles[3][x].color = '#6d6f7a'; tiles[3][x].pass = false;
      tiles[h - 4][x].h = 2.5; tiles[h - 4][x].color = '#6d6f7a'; tiles[h - 4][x].pass = false;
    }
    for (let y = 4; y < h - 4; y++) {
      tiles[y][2].h = 2.5; tiles[y][2].color = '#6d6f7a'; tiles[y][2].pass = false;
      tiles[y][w - 3].h = 2.5; tiles[y][w - 3].color = '#6d6f7a'; tiles[y][w - 3].pass = false;
    }
    // Gate opening
    tiles[3][Math.floor(w/2)].pass = true; tiles[3][Math.floor(w/2)].h = 1.5; tiles[3][Math.floor(w/2)].color = '#7b7f8c';
    // Inner keep/platform
    for (let y = 6; y <= 9; y++) for (let x = 6; x <= 9; x++) {
      tiles[y][x].h = 1.5; tiles[y][x].color = '#465a7a';
    }
    // Buildings with roofs
    const houses = [ {x:4,y:6,w:2,h:2}, {x:11,y:8,w:2,h:2}, {x:4,y:11,w:3,h:2} ];
    for (const b of houses) {
      for (let yy=0; yy<b.h; yy++) for (let xx=0; xx<b.w; xx++) {
        const tx = b.x+xx, ty=b.y+yy;
        tiles[ty][tx].h = 1.0; tiles[ty][tx].color = '#7a5555'; tiles[ty][tx].roof = true; tiles[ty][tx].pass = false;
      }
    }
    // Ramps and stairs
    tiles[10][5].h = 1.0; tiles[10][6].h = 1.0; tiles[9][5].h = 1.5; tiles[9][6].h = 1.5;
    tiles[7][10].h = 1.0; tiles[8][10].h = 1.5; tiles[9][10].h = 2.0; tiles[10][10].h = 2.5; tiles[10][10].pass=false; // tower corner

    // Cobblestone road
    for (let x = 1; x < w - 1; x++) tiles[Math.floor(h/2)][x].color = '#374e74';

    return { w, h, tiles };
  }

  function createJobs() {
    const jobs = {};
    jobs['Knight'] = {
      color: '#8fb4ff',
      attack: { key:'attack', name:'Slash', range:1, aoe:0, ct: 25, power: 12, kind:'damage', baseHit:0.85 },
      abilities: [
        { key:'smite', name:'Smite', range:1, aoe:0, ct: 35, power: 18, kind:'damage', baseHit:0.8 },
      ],
    };
    jobs['Archer'] = {
      color: '#c1e799',
      attack: { key:'attack', name:'Arrow', range:5, aoe:0, ct: 30, power: 10, kind:'damage', baseHit:0.75 },
      abilities: [
        { key:'aim', name:'Power Shot', range:5, aoe:0, ct: 45, power: 18, kind:'damage', baseHit:0.7 },
      ],
    };
    jobs['Mage'] = {
      color: '#d6a2ff',
      attack: { key:'attack', name:'Bonk', range:1, aoe:0, ct: 25, power: 6, kind:'damage', baseHit:0.85 },
      abilities: [
        { key:'fire', name:'Fire', range:3, aoe:1, ct: 40, power: 16, kind:'damage', baseHit:0.95, reqLoS:false },
      ],
    };
    jobs['Priest'] = {
      color: '#fff0a8',
      attack: { key:'attack', name:'Staff', range:1, aoe:0, ct: 25, power: 6, kind:'damage', baseHit:0.85 },
      abilities: [
        { key:'cure', name:'Cure', range:3, aoe:0, ct: 35, power: 14, kind:'heal', baseHit:1.0, reqLoS:false },
      ],
    };
    return jobs;
  }

  function createUnits(map) {
    let uid = 1;
    const mkUnit = (name, job, team, x, y) => {
      const u = {
        id: uid++, name, job, team, color: (team==='Blue'? '#4fc3f7':'#ff6b6b'),
        pos: { x, y, z: map.tiles[y][x].h },
        stats: {
          lvl: 1, exp: 0, jp: 0,
          hp: 40, maxhp: 40, spd: 8 + irnd(0,2), mov: job==='Knight'?4:(job==='Archer'?4:3), jump: job==='Knight'?2:1,
          atk: job==='Knight'?8:(job==='Archer'?7:4), mag: job==='Mage'?8:(job==='Priest'?7:3),
        },
        abilities: [...JOBS[job].abilities],
        ct: 0,
        alive: true,
        facing: team==='Blue'?0:2,
      };
      u.face = generateFace(u.name);
      return u;
    };

    const blues = [
      mkUnit('Garnet', 'Knight', 'Blue', 5, 12),
      mkUnit('Balfon', 'Archer', 'Blue', 6, 12),
      mkUnit('Eiko', 'Mage', 'Blue', 5, 10),
      mkUnit('Rosa', 'Priest', 'Blue', 7, 12),
    ];
    const reds = [
      mkUnit('Dyne', 'Knight', 'Red', 10, 4),
      mkUnit('Lia', 'Archer', 'Red', 11, 5),
      mkUnit('Vivi', 'Mage', 'Red', 9, 4),
      mkUnit('Lenna', 'Priest', 'Red', 12, 5),
    ];
    return [...blues, ...reds];
  }

  // Enemy AI: per-job strategies for Red team
  function aiAct(u) {
    if (!u || u.alive === false || game.activeId !== u.id) return;
    if (u.job === 'Priest') { return aiPriest(u); }
    if (u.job === 'Mage') { return aiMage(u); }
    if (u.job === 'Archer') { return aiArcher(u); }
    return aiKnight(u);
  }

  function aiPriest(u){
    // Heal lowest-HP ally in range; otherwise reposition toward allies or bonk
    const cure = u.abilities.find(a=>a.key==='cure');
    const allies = units.filter(t=>t.team===u.team && t.alive!==false && t.stats.hp < t.stats.maxhp);
    let best=null;
    if (cure) {
      const tiles = computeAbilityTiles(u.pos, cure);
      for (const tile of tiles){
        const eff = computeAbilityEffectAtCursor({ ability:cure, origin:u.pos, cursor:tile });
        const val = eff.filter(e=>idUnit.get(e.id).team===u.team).reduce((s,e)=>s + e.amount*e.hit,0);
        if (val>0 && (!best || val>best.value)) best = { ability:cure, tile, value:val };
      }
      if (best){ game.phase='targeting'; game.targeting={ability:cure, origin:{x:u.pos.x,y:u.pos.y}, cursor:best.tile}; confirmAction(); return; }
    }
    // otherwise, move toward most injured ally
    if (allies.length){
      const target = allies.sort((a,b)=> (a.stats.hp/a.stats.maxhp) - (b.stats.hp/b.stats.maxhp))[0];
      return aiMoveTowardAndMaybeAttack(u, target);
    }
    return endTurn(u, 10);
  }
  function aiMage(u){
    const fire = u.abilities.find(a=>a.key==='fire');
    if (fire){
      let best=null;
      const tiles = computeAbilityTiles(u.pos, fire);
      for (const tile of tiles){
        const eff = computeAbilityEffectAtCursor({ ability:fire, origin:u.pos, cursor:tile });
        // prefer hitting enemies and avoid friendly fire
        const val = eff.reduce((s,e)=> s + (idUnit.get(e.id).team!==u.team ? e.amount*e.hit : -e.amount*0.5), 0);
        if (val>5 && (!best || val>best.value)) best={ ability:fire, tile, value:val };
      }
      if (best){ game.phase='targeting'; game.targeting={ability:fire, origin:{x:u.pos.x,y:u.pos.y}, cursor:best.tile}; confirmAction(); return; }
    }
    // else basic attack if adjacent
    const enemies = units.filter(x=>x.team!==u.team && x.alive!==false);
    const near = enemies.find(t=>gridDist(u.pos, t.pos)<=1);
    if (near){ game.phase='targeting'; game.targeting={ability:JOBS[u.job].attack, origin:{x:u.pos.x,y:u.pos.y}, cursor:near.pos}; confirmAction(); return; }
    // move toward cluster of enemies
    const target = enemies.sort((a,b)=> gridDist(u.pos,a.pos)-gridDist(u.pos,b.pos))[0];
    return aiMoveTowardAndMaybeAttack(u, target);
  }
  function aiArcher(u){
    // Attempt best shot with LoS from current or reachable tiles
    const abilities = [ ...u.abilities, JOBS[u.job].attack ];
    let best=null;
    const considerTiles = candidateMoveTiles(u);
    for (const pos of considerTiles){
      for (const ab of abilities){
        const tiles = computeAbilityTiles(pos, ab);
        for (const tile of tiles){
          const eff = computeAbilityEffectAtCursor({ ability:ab, origin:pos, cursor:tile });
          const val = eff.filter(e=>idUnit.get(e.id).team!==u.team).reduce((s,e)=>s + e.amount*e.hit,0);
          if (val>0 && (!best || val>best.value)) best={ from:pos, ability:ab, tile, value:val };
        }
      }
    }
    if (best){
      if (best.from.x!==u.pos.x || best.from.y!==u.pos.y){
        // move first
        const path = findPath(u.pos, best.from, u.stats.mov, u.stats.jump);
        if (path){ u.anim={kind:'move', path, index:0, t:0, speed:6.0}; game.anim={...u.anim, unitId:u.id}; game.phase='anim';
          setTimeout(()=>{ game.phase='targeting'; game.targeting={ability:best.ability, origin:{x:best.from.x,y:best.from.y}, cursor:best.tile}; confirmAction(); }, 400);
          return; }
      }
      game.phase='targeting'; game.targeting={ability:best.ability, origin:{x:u.pos.x,y:u.pos.y}, cursor:best.tile}; confirmAction(); return;
    }
    // otherwise kite away from nearest enemy
    const enemies = units.filter(x=>x.team!==u.team && x.alive!==false);
    const nearest = enemies.sort((a,b)=> gridDist(u.pos,a.pos)-gridDist(u.pos,b.pos))[0];
    return aiMoveTowardAndMaybeAttack(u, nearest, { preferDistance:true });
  }
  function aiKnight(u){
    const enemies = units.filter(x=>x.team!==u.team && x.alive!==false);
    // If adjacent, use best melee
    const adjacent = enemies.find(t=>gridDist(u.pos,t.pos)<=1);
    if (adjacent){
      const ab = u.abilities.find(a=>a.key==='smite') || JOBS[u.job].attack;
      game.phase='targeting'; game.targeting={ability:ab, origin:{x:u.pos.x,y:u.pos.y}, cursor:adjacent.pos}; confirmAction(); return;
    }
    // Else move to back/side if possible near nearest
    const target = enemies.sort((a,b)=> gridDist(u.pos,a.pos)-gridDist(u.pos,b.pos))[0];
    // tiles around target, prefer behind
    const dirs = [ {dx:0,dy:1,score:3}, {dx:1,dy:0,score:2}, {dx:-1,dy:0,score:2}, {dx:0,dy:-1,score:1} ];
    let best=null;
    for (const d of dirs){
      const tx = target.pos.x + d.dx, ty = target.pos.y + d.dy;
      const path = findPath(u.pos, {x:tx,y:ty}, u.stats.mov, u.stats.jump);
      if (path){ const score = d.score - path.length*0.1; if (!best || score>best.score) best={ to:{x:tx,y:ty}, score } }
    }
    if (best){ u.pos.x = best.to.x; u.pos.y = best.to.y; showToast(`${u.name} advances.`); }
    // Try attack if now adjacent
    const adj2 = enemies.find(t=>gridDist(u.pos,t.pos)<=1);
    if (adj2){ const ab = u.abilities.find(a=>a.key==='smite') || JOBS[u.job].attack; game.phase='targeting'; game.targeting={ability:ab, origin:{x:u.pos.x,y:u.pos.y}, cursor:adj2.pos}; confirmAction(); return; }
    return endTurn(u, 15);
  }

  // Helpers for AI
  function candidateMoveTiles(u){
    const occ = new Set(units.filter(r=>r.alive!==false && r.id!==u.id).map(r=>`${r.pos.x},${r.pos.y}`));
    const tiles=[];
    for (let y=0;y<map.h;y++) for (let x=0;x<map.w;x++){
      const d = Math.abs(x-u.pos.x)+Math.abs(y-u.pos.y);
      if (d<=u.stats.mov && insideMap(x,y) && map.tiles[y][x].pass && !occ.has(`${x},${y}`)){
        const h1 = map.tiles[u.pos.y][u.pos.x].h, h2 = map.tiles[y][x].h;
        if (Math.abs(h2-h1) <= u.stats.jump) tiles.push({x,y});
      }
    }
    tiles.push({x:u.pos.x,y:u.pos.y});
    return tiles;
  }
  function aiMoveTowardAndMaybeAttack(u, target, opts={}){
    const currentD = gridDist(u.pos, target.pos);
    let best = { x:u.pos.x, y:u.pos.y, score: -Infinity };
    const tiles = candidateMoveTiles(u);
    for (const t of tiles){
      const d = gridDist(t, target.pos);
      let score = -d;
      if (opts.preferDistance) score = -Math.abs(4 - d); // keep 3-5 tiles
      // prefer high ground
      score += map.tiles[t.y][t.x].h * 0.2;
      if (score>best.score) best = { x:t.x, y:t.y, score };
    }
    if (best.x!==u.pos.x || best.y!==u.pos.y){ u.pos.x=best.x; u.pos.y=best.y; showToast(`${u.name} repositions.`); }
    // try attack now
    const ab = JOBS[u.job].attack;
    const eff = computeAbilityEffectAtCursor({ ability:ab, origin:u.pos, cursor: target.pos });
    const vsEnemy = eff.filter(e=>idUnit.get(e.id).team!==u.team);
    if (vsEnemy.length){ game.phase='targeting'; game.targeting={ability:ab, origin:{x:u.pos.x,y:u.pos.y}, cursor:target.pos}; confirmAction(); return; }
    return endTurn(u, 12);
  }

})();
