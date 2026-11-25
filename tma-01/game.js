// TMA-01: 9:16 One-Thumb Physics Ricochet & Merge Roguelite Mini-Game
// Deterministic WebGL/Canvas Arena with Procedural Synth SFX & Roguelite Draft
(function() {
  'use strict';

  const VIEW_WIDTH = 390;
  const VIEW_HEIGHT = 844;
  const ARENA_LEFT = 16;
  const ARENA_RIGHT = 374;
  const ARENA_TOP = 64;
  const ARENA_BOTTOM = 750;
  const LAUNCHER_X = 195;
  const LAUNCHER_Y = 735;

  // Procedural WebAudio Synth (Zero External Network Assets)
  class AudioSynth {
    constructor() {
      this.ctx = null;
    }
    init() {
      if (this.ctx) return;
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) {
          this.ctx = new AudioContextClass();
        }
      } catch (_) {}
    }
    playTone(freq, type, duration, gainVal = 0.08) {
      this.init();
      if (!this.ctx) return;
      try {
        if (this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => {});
        }
        const now = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, now);
        gain.gain.setValueAtTime(gainVal, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(now);
        osc.stop(now + duration);
      } catch (_) {}
    }
    ricochet() { this.playTone(520, 'sine', 0.04, 0.04); }
    hit() { this.playTone(280, 'square', 0.05, 0.06); }
    merge() { this.playTone(660, 'triangle', 0.12, 0.08); }
    shoot() { this.playTone(420, 'sine', 0.06, 0.05); }
    upgrade() { this.playTone(880, 'sine', 0.18, 0.09); }
    explosion() { this.playTone(130, 'sawtooth', 0.22, 0.1); }
  }

  const sfx = new AudioSynth();

  // Deterministic PRNG: Mulberry32
  function createPrng(seed) {
    let s = (seed >>> 0) || 1;
    return function() {
      s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const UPGRADE_CARDS = [
    { id: 'split', title: 'Split-Shot', desc: '+1 Ball split on ricochet', icon: '⚡' },
    { id: 'lightning', title: 'Chain Lightning', desc: 'Hits arc to nearby hazards', icon: '⛓' },
    { id: 'vortex', title: 'Gravity Well', desc: 'Vortex pulls & damages hazards', icon: '🌀' },
    { id: 'magnet', title: 'Orb Magnet', desc: 'Attract drop-merge orbs', icon: '🧲' },
    { id: 'shield', title: 'Fortified Shield', desc: '+1 Breach defense barrier', icon: '🛡' }
  ];

  // Game Engine State
  let canvas = null;
  let ctx = null;
  let rng = createPrng(42);

  let phase = 'aiming'; // 'aiming', 'firing', 'draft', 'awaiting_revive', 'game_over'
  let wave = 1;
  let score = 0;
  let combo = 0;
  let gameOver = false;
  let awaitingRevive = false;
  let reviveUsed = false;

  let totalBalls = 6;
  let ballsToFire = 0;
  let fireTimer = 0;
  let aimVector = { x: 0, y: -1 };
  let isAiming = false;

  let balls = [];
  let hazards = [];
  let mergeOrbs = [];
  let particles = [];
  let floatingTexts = [];
  let shockwaves = [];
  let draftChoices = [];

  let upgrades = {
    splitShot: 0,
    chainLightning: 0,
    gravityWell: 0,
    magnet: 0,
    shield: 1
  };

  let shakeIntensity = 0;
  let hitstopFrames = 0;
  let autoLoopActive = false;

  function initCanvas() {
    canvas = document.getElementById('game-canvas');
    if (canvas) {
      ctx = canvas.getContext('2d');
      canvas.width = VIEW_WIDTH;
      canvas.height = VIEW_HEIGHT;
    }
  }

  function spawnWaveHazards() {
    hazards = [];
    const cols = 5;
    const rows = Math.min(2 + Math.floor(wave / 3), 4);
    const startY = ARENA_TOP + 50;
    const colWidth = (ARENA_RIGHT - ARENA_LEFT) / cols;

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (rng() > 0.15) {
          const hp = Math.floor(wave * 6 + rng() * wave * 4 + 4);
          const x = ARENA_LEFT + colWidth * c + colWidth / 2;
          const y = startY + r * 56;
          const isHex = rng() > 0.5;
          const colors = ['#00f0ff', '#ff0055', '#ffe600', '#00ff88', '#b537f2'];
          const color = colors[Math.floor(rng() * colors.length)];
          hazards.push({
            id: `h_${r}_${c}_${wave}`,
            x,
            y,
            radius: 20,
            hp,
            maxHp: hp,
            isHex,
            color
          });
        }
      }
    }
  }

  function generateDraftCards() {
    const pool = [...UPGRADE_CARDS];
    const picked = [];
    for (let i = 0; i < 3 && pool.length > 0; i++) {
      const idx = Math.floor(rng() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked;
  }

  function applyUpgrade(card) {
    if (!card) return;
    if (card.id === 'split') upgrades.splitShot++;
    if (card.id === 'lightning') upgrades.chainLightning++;
    if (card.id === 'vortex') upgrades.gravityWell++;
    if (card.id === 'magnet') upgrades.magnet++;
    if (card.id === 'shield') upgrades.shield++;
    totalBalls += 1;
    sfx.upgrade();
  }

  function addParticle(x, y, vx, vy, color, life, size = 3) {
    particles.push({ x, y, vx, vy, color, life, maxLife: life, size });
  }

  function spawnSparks(x, y, count, color) {
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const speed = 1.5 + rng() * 3.5;
      addParticle(
        x,
        y,
        Math.cos(angle) * speed,
        Math.sin(angle) * speed,
        color,
        15 + Math.floor(rng() * 12),
        2 + rng() * 2
      );
    }
  }

  function addFloatingText(x, y, text, color) {
    floatingTexts.push({
      x,
      y,
      text,
      color,
      life: 28,
      maxLife: 28
    });
  }

  function addShockwave(x, y, maxRadius, color = '#00f0ff') {
    shockwaves.push({
      x,
      y,
      radius: 4,
      maxRadius,
      color,
      life: 18,
      maxLife: 18
    });
  }

  function spawnMergeOrb(x, y, value) {
    mergeOrbs.push({
      x,
      y,
      vx: (rng() - 0.5) * 3,
      vy: (rng() - 0.5) * 3,
      radius: 12 + Math.min(Math.log2(value) * 2, 10),
      value
    });
  }

  function reset(seed = 42) {
    rng = createPrng(seed);
    phase = 'aiming';
    wave = 1;
    score = 0;
    combo = 0;
    gameOver = false;
    awaitingRevive = false;
    reviveUsed = false;

    totalBalls = 6;
    ballsToFire = 0;
    fireTimer = 0;
    aimVector = { x: 0, y: -1 };
    isAiming = false;

    balls = [];
    mergeOrbs = [];
    particles = [];
    floatingTexts = [];
    shockwaves = [];
    draftChoices = [];

    upgrades = {
      splitShot: 0,
      chainLightning: 0,
      gravityWell: 0,
      magnet: 0,
      shield: 1
    };

    shakeIntensity = 0;
    hitstopFrames = 0;

    initCanvas();
    spawnWaveHazards();
  }

  function triggerFire() {
    if (ballsToFire > 0) return;
    ballsToFire = totalBalls;
    fireTimer = 0;
    phase = 'firing';
    sfx.shoot();
  }

  function step(dt_ms = 16.6667, input = {}) {
    if (!canvas) initCanvas();

    const dtFactor = Math.min(Math.max(dt_ms / 16.6667, 0.5), 2.0);

    // Process Hitstop
    if (hitstopFrames > 0) {
      hitstopFrames--;
      render();
      return;
    }

    // Input parsing: coordinates
    let pointerX = input.x != null ? (input.x <= 1.0 ? input.x * VIEW_WIDTH : input.x) : LAUNCHER_X;
    let pointerY = input.y != null ? (input.y <= 1.0 ? input.y * VIEW_HEIGHT : input.y) : LAUNCHER_Y - 100;

    // Handle Roguelite Draft Phase
    if (phase === 'draft') {
      if (input.choice !== null && input.choice !== undefined && draftChoices.length > 0) {
        const choiceIdx = Math.abs(input.choice) % draftChoices.length;
        applyUpgrade(draftChoices[choiceIdx]);
        wave++;
        spawnWaveHazards();
        phase = 'aiming';
        combo = 0;
      } else if (input.tap) {
        // Tap selection based on 3 vertical/horizontal zones
        const cardWidth = 100;
        const startX = (VIEW_WIDTH - (cardWidth * 3 + 20)) / 2;
        let selected = 0;
        if (pointerX > startX + cardWidth + 10) selected = 1;
        if (pointerX > startX + (cardWidth + 10) * 2) selected = 2;
        if (draftChoices[selected]) {
          applyUpgrade(draftChoices[selected]);
          wave++;
          spawnWaveHazards();
          phase = 'aiming';
          combo = 0;
        }
      }
      render();
      return;
    }

    // Handle Awaiting Revive Phase
    if (phase === 'awaiting_revive') {
      if (input.tap || input.down || (input.choice !== null && input.choice !== undefined)) {
        // Trigger emergency continue bomb!
        reviveUsed = true;
        awaitingRevive = false;
        upgrades.shield = 1;
        addShockwave(LAUNCHER_X, LAUNCHER_Y, 260, '#00f0ff');
        sfx.explosion();
        // Clear bottom hazards
        hazards = hazards.filter(h => {
          if (h.y > ARENA_BOTTOM - 200) {
            score += h.hp * 10;
            spawnMergeOrb(h.x, h.y, 2);
            return false;
          }
          return true;
        });
        addFloatingText(LAUNCHER_X, LAUNCHER_Y - 80, 'REVIVE SHOCKWAVE!', '#00ff88');
        phase = 'aiming';
      }
      render();
      return;
    }

    if (phase === 'game_over') {
      render();
      return;
    }

    // Aiming & Firing Input handling
    if (input.down) {
      isAiming = true;
      const dx = pointerX - LAUNCHER_X;
      let dy = pointerY - LAUNCHER_Y;
      if (dy > -20) dy = -20; // Constrain to shoot upward
      const len = Math.hypot(dx, dy) || 1;
      aimVector = { x: dx / len, y: dy / len };
    }

    if (input.tap) {
      isAiming = false;
      triggerFire();
    }

    // Continuous Firing Queue
    if (ballsToFire > 0) {
      fireTimer += dtFactor;
      if (fireTimer >= 2.5) {
        fireTimer = 0;
        ballsToFire--;
        const speed = 15;
        balls.push({
          x: LAUNCHER_X,
          y: LAUNCHER_Y,
          vx: aimVector.x * speed,
          vy: aimVector.y * speed,
          radius: 5,
          active: true,
          damage: 1,
          splitCount: 0
        });
        sfx.shoot();
      }
    }

    // Update Balls Physics & Ricochet
    for (let i = balls.length - 1; i >= 0; i--) {
      const b = balls[i];
      if (!b.active) continue;

      b.x += b.vx * dtFactor;
      b.y += b.vy * dtFactor;

      // Wall Ricochet
      if (b.x - b.radius <= ARENA_LEFT) {
        b.x = ARENA_LEFT + b.radius;
        b.vx = Math.abs(b.vx);
        sfx.ricochet();
        spawnSparks(b.x, b.y, 2, '#00f0ff');
      } else if (b.x + b.radius >= ARENA_RIGHT) {
        b.x = ARENA_RIGHT - b.radius;
        b.vx = -Math.abs(b.vx);
        sfx.ricochet();
        spawnSparks(b.x, b.y, 2, '#00f0ff');
      }

      if (b.y - b.radius <= ARENA_TOP) {
        b.y = ARENA_TOP + b.radius;
        b.vy = Math.abs(b.vy);
        sfx.ricochet();
        spawnSparks(b.x, b.y, 2, '#00f0ff');
      }

      // Hazard Collision Detection
      for (let j = hazards.length - 1; j >= 0; j--) {
        const h = hazards[j];
        const dist = Math.hypot(b.x - h.x, b.y - h.y);
        const minDist = b.radius + h.radius;

        if (dist < minDist) {
          // Ricochet Reflection
          const nx = (b.x - h.x) / (dist || 1);
          const ny = (b.y - h.y) / (dist || 1);
          b.x = h.x + nx * minDist;
          b.y = h.y + ny * minDist;

          const dot = b.vx * nx + b.vy * ny;
          b.vx -= 2 * dot * nx;
          b.vy -= 2 * dot * ny;

          // Apply Damage
          const dmg = b.damage;
          h.hp -= dmg;
          combo++;
          score += dmg * 10 * combo;
          shakeIntensity = Math.min(shakeIntensity + 1.8, 8);
          hitstopFrames = 1;
          sfx.hit();

          spawnSparks(b.x, b.y, 4, h.color);
          addFloatingText(h.x, h.y - 12, `+${dmg * 10 * combo}`, '#ffe600');

          // Split-Shot Upgrade
          if (upgrades.splitShot > 0 && b.splitCount < upgrades.splitShot) {
            b.splitCount++;
            const angle = 0.35;
            const cos = Math.cos(angle);
            const sin = Math.sin(angle);
            balls.push({
              x: b.x,
              y: b.y,
              vx: b.vx * cos - b.vy * sin,
              vy: b.vx * sin + b.vy * cos,
              radius: 4,
              active: true,
              damage: 1,
              splitCount: b.splitCount
            });
          }

          // Chain Lightning Upgrade
          if (upgrades.chainLightning > 0) {
            for (let k = 0; k < hazards.length; k++) {
              if (k !== j) {
                const target = hazards[k];
                if (Math.hypot(target.x - h.x, target.y - h.y) < 90) {
                  target.hp -= 2 * upgrades.chainLightning;
                  spawnSparks(target.x, target.y, 3, '#00ff88');
                  addFloatingText(target.x, target.y, 'CHAIN!', '#00ff88');
                  break;
                }
              }
            }
          }

          // Destroyed Hazard
          if (h.hp <= 0) {
            score += 100 * combo;
            spawnSparks(h.x, h.y, 14, h.color);
            addShockwave(h.x, h.y, 32, h.color);
            addFloatingText(h.x, h.y, 'CLEAR!', '#00f0ff');
            sfx.explosion();
            spawnMergeOrb(h.x, h.y, 2);
            hazards.splice(j, 1);
          }
          break;
        }
      }

      // Bottom Collection Line
      if (b.y >= ARENA_BOTTOM) {
        b.active = false;
      }
    }

    // Clean inactive balls
    balls = balls.filter(b => b.active);

    // Gravity Well Upgrade: Pull and slowly damage hazards
    if (upgrades.gravityWell > 0 && hazards.length > 0) {
      const wellX = VIEW_WIDTH / 2;
      const wellY = (ARENA_TOP + ARENA_BOTTOM) / 2;
      for (const h of hazards) {
        const dx = wellX - h.x;
        const dy = wellY - h.y;
        const d = Math.hypot(dx, dy) || 1;
        if (d < 180) {
          h.x += (dx / d) * 0.4 * upgrades.gravityWell;
          h.y += (dy / d) * 0.4 * upgrades.gravityWell;
        }
      }
    }

    // Update Merge Orbs & Drop-Merge Mechanics
    for (let i = 0; i < mergeOrbs.length; i++) {
      const orbA = mergeOrbs[i];
      orbA.x += orbA.vx * dtFactor;
      orbA.y += orbA.vy * dtFactor;
      orbA.vx *= 0.97;
      orbA.vy *= 0.97;

      // Magnet pull
      if (upgrades.magnet > 0) {
        const dx = LAUNCHER_X - orbA.x;
        const dy = LAUNCHER_Y - orbA.y;
        const d = Math.hypot(dx, dy) || 1;
        orbA.vx += (dx / d) * 0.3 * upgrades.magnet;
        orbA.vy += (dy / d) * 0.3 * upgrades.magnet;
      }

      // Arena constraints for orbs
      if (orbA.x - orbA.radius < ARENA_LEFT) { orbA.x = ARENA_LEFT + orbA.radius; orbA.vx *= -1; }
      if (orbA.x + orbA.radius > ARENA_RIGHT) { orbA.x = ARENA_RIGHT - orbA.radius; orbA.vx *= -1; }
      if (orbA.y - orbA.radius < ARENA_TOP) { orbA.y = ARENA_TOP + orbA.radius; orbA.vy *= -1; }
      if (orbA.y + orbA.radius > ARENA_BOTTOM) { orbA.y = ARENA_BOTTOM - orbA.radius; orbA.vy *= -0.5; }

      // Orb-to-Orb Merge Collisions
      for (let j = i + 1; j < mergeOrbs.length; j++) {
        const orbB = mergeOrbs[j];
        if (orbA.value === orbB.value) {
          const d = Math.hypot(orbA.x - orbB.x, orbA.y - orbB.y);
          if (d < orbA.radius + orbB.radius) {
            // Merge into higher tier!
            orbA.value *= 2;
            orbA.radius = Math.min(12 + Math.log2(orbA.value) * 2, 24);
            score += orbA.value * 50;
            combo += 2;
            shakeIntensity = 5;
            sfx.merge();
            addFloatingText(orbA.x, orbA.y, `MERGE ${orbA.value}!`, '#ff0055');
            addShockwave(orbA.x, orbA.y, 60, '#ff0055');

            // Damage nearby hazards from merge blast
            for (const h of hazards) {
              if (Math.hypot(h.x - orbA.x, h.y - orbA.y) < 70) {
                h.hp -= orbA.value;
                spawnSparks(h.x, h.y, 3, '#ff0055');
              }
            }
            hazards = hazards.filter(h => h.hp > 0);
            mergeOrbs.splice(j, 1);
            break;
          }
        }
      }
    }

    // Update Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dtFactor;
      p.y += p.vy * dtFactor;
      p.life -= dtFactor;
      if (p.life <= 0) particles.splice(i, 1);
    }

    // Update Floating Texts
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
      const ft = floatingTexts[i];
      ft.y -= 0.8 * dtFactor;
      ft.life -= dtFactor;
      if (ft.life <= 0) floatingTexts.splice(i, 1);
    }

    // Update Shockwaves
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const sw = shockwaves[i];
      sw.radius += (sw.maxRadius - sw.radius) * 0.15 * dtFactor;
      sw.life -= dtFactor;
      if (sw.life <= 0) shockwaves.splice(i, 1);
    }

    // End of Turn Checks
    if (phase === 'firing' && balls.length === 0 && ballsToFire === 0) {
      if (hazards.length === 0) {
        // Wave Cleared -> 3-Card Roguelite Upgrade Draft
        phase = 'draft';
        draftChoices = generateDraftCards();
        sfx.upgrade();
      } else {
        // Advance Hazards Downward
        let breached = false;
        for (const h of hazards) {
          h.y += 38;
          if (h.y + h.radius >= ARENA_BOTTOM - 15) {
            breached = true;
          }
        }

        if (breached) {
          if (upgrades.shield > 0) {
            upgrades.shield--;
            hazards = hazards.filter(h => h.y + h.radius < ARENA_BOTTOM - 15);
            addShockwave(LAUNCHER_X, ARENA_BOTTOM, 120, '#00ff88');
            addFloatingText(LAUNCHER_X, ARENA_BOTTOM - 40, 'SHIELD ABSORB!', '#00ff88');
            shakeIntensity = 8;
            phase = 'aiming';
          } else if (!reviveUsed) {
            awaitingRevive = true;
            phase = 'awaiting_revive';
            addFloatingText(LAUNCHER_X, ARENA_BOTTOM - 100, 'CRITICAL BREACH!', '#ff0055');
          } else {
            gameOver = true;
            phase = 'game_over';
          }
        } else {
          phase = 'aiming';
        }
      }
    }

    render();
  }

  function render() {
    if (!ctx) return;

    ctx.save();
    // Screen-shake offset
    if (shakeIntensity > 0) {
      const sx = (rng() - 0.5) * shakeIntensity * 2;
      const sy = (rng() - 0.5) * shakeIntensity * 2;
      ctx.translate(sx, sy);
      shakeIntensity = Math.max(0, shakeIntensity - 0.35);
    }

    // Background
    ctx.fillStyle = '#080913';
    ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

    // Arena boundary glow
    ctx.strokeStyle = 'rgba(0, 240, 255, 0.2)';
    ctx.lineWidth = 2;
    ctx.strokeRect(ARENA_LEFT, ARENA_TOP, ARENA_RIGHT - ARENA_LEFT, ARENA_BOTTOM - ARENA_TOP);

    // Grid pattern
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let x = ARENA_LEFT; x <= ARENA_RIGHT; x += 36) {
      ctx.beginPath();
      ctx.moveTo(x, ARENA_TOP);
      ctx.lineTo(x, ARENA_BOTTOM);
      ctx.stroke();
    }
    for (let y = ARENA_TOP; y <= ARENA_BOTTOM; y += 44) {
      ctx.beginPath();
      ctx.moveTo(ARENA_LEFT, y);
      ctx.lineTo(ARENA_RIGHT, y);
      ctx.stroke();
    }

    // Header HUD
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`WAVE ${wave}`, ARENA_LEFT + 4, 38);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#00f0ff';
    ctx.fillText(`SCORE ${score}`, VIEW_WIDTH / 2, 38);

    ctx.textAlign = 'right';
    ctx.fillStyle = combo > 1 ? '#ffe600' : '#888888';
    ctx.fillText(`COMBO x${combo}`, ARENA_RIGHT - 4, 38);

    // Shields & Upgrades indicator
    let badgeX = ARENA_LEFT + 4;
    for (let s = 0; s < upgrades.shield; s++) {
      ctx.fillStyle = '#00ff88';
      ctx.font = '12px sans-serif';
      ctx.fillText('🛡', badgeX, 56);
      badgeX += 16;
    }

    // Draw Shockwaves
    for (const sw of shockwaves) {
      const alpha = Math.max(0, sw.life / sw.maxLife);
      ctx.strokeStyle = sw.color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, sw.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    }

    // Draw Hazards
    for (const h of hazards) {
      ctx.save();
      ctx.translate(h.x, h.y);

      // Hazard body
      ctx.fillStyle = '#121526';
      ctx.strokeStyle = h.color;
      ctx.lineWidth = 2.5;

      ctx.beginPath();
      if (h.isHex) {
        for (let a = 0; a < 6; a++) {
          const angle = (a * Math.PI) / 3;
          const px = Math.cos(angle) * h.radius;
          const py = Math.sin(angle) * h.radius;
          if (a === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
      } else {
        ctx.arc(0, 0, h.radius, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.stroke();

      // Number label (HP)
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 13px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(h.hp.toString(), 0, 1);

      ctx.restore();
    }

    // Draw Merge Orbs
    for (const orb of mergeOrbs) {
      ctx.save();
      ctx.translate(orb.x, orb.y);
      ctx.fillStyle = '#ff0055';
      ctx.beginPath();
      ctx.arc(0, 0, orb.radius, 0, Math.PI * 2);
      ctx.fill();

      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(orb.value.toString(), 0, 1);
      ctx.restore();
    }

    // Draw Balls
    for (const b of balls) {
      ctx.fillStyle = '#00f0ff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Draw Aiming Guide Trajectory
    if (isAiming || phase === 'aiming') {
      ctx.strokeStyle = 'rgba(0, 240, 255, 0.4)';
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(LAUNCHER_X, LAUNCHER_Y);
      let curX = LAUNCHER_X;
      let curY = LAUNCHER_Y;
      let curVx = aimVector.x * 240;
      let curVy = aimVector.y * 240;
      ctx.lineTo(curX + curVx, curY + curVy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw Launcher Turret
    ctx.fillStyle = '#00f0ff';
    ctx.beginPath();
    ctx.arc(LAUNCHER_X, LAUNCHER_Y, 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(LAUNCHER_X, LAUNCHER_Y);
    ctx.lineTo(LAUNCHER_X + aimVector.x * 22, LAUNCHER_Y + aimVector.y * 22);
    ctx.stroke();

    // Draw Particles
    for (const p of particles) {
      ctx.fillStyle = p.color;
      ctx.globalAlpha = Math.max(0, p.life / p.maxLife);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1.0;
    }

    // Draw Floating Texts
    for (const ft of floatingTexts) {
      ctx.fillStyle = ft.color;
      ctx.globalAlpha = Math.max(0, ft.life / ft.maxLife);
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ft.text, ft.x, ft.y);
      ctx.globalAlpha = 1.0;
    }

    // Overlay: Roguelite Draft 3 Cards
    if (phase === 'draft') {
      ctx.fillStyle = 'rgba(5, 7, 18, 0.88)';
      ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

      ctx.fillStyle = '#ffe600';
      ctx.font = 'bold 20px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SELECT AN UPGRADE', VIEW_WIDTH / 2, 280);

      const cardW = 100;
      const cardH = 140;
      const startX = (VIEW_WIDTH - (cardW * 3 + 20)) / 2;
      const startY = 320;

      for (let i = 0; i < draftChoices.length; i++) {
        const c = draftChoices[i];
        const cx = startX + i * (cardW + 10);
        ctx.fillStyle = '#141a33';
        ctx.strokeStyle = '#00f0ff';
        ctx.lineWidth = 2;
        ctx.fillRect(cx, startY, cardW, cardH);
        ctx.strokeRect(cx, startY, cardW, cardH);

        ctx.font = '24px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(c.icon, cx + cardW / 2, startY + 40);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText(c.title, cx + cardW / 2, startY + 75);

        ctx.fillStyle = '#aaaaaa';
        ctx.font = '10px sans-serif';
        ctx.fillText(c.desc, cx + cardW / 2, startY + 105);
      }
    }

    // Overlay: Awaiting Revive
    if (phase === 'awaiting_revive') {
      ctx.fillStyle = 'rgba(20, 0, 10, 0.85)';
      ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

      ctx.fillStyle = '#ff0055';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('DEFENSE BREACHED!', VIEW_WIDTH / 2, 380);

      ctx.fillStyle = '#ffffff';
      ctx.font = '15px sans-serif';
      ctx.fillText('TAP TO TRIGGER REVIVE BOMB', VIEW_WIDTH / 2, 420);
    }

    // Overlay: Game Over
    if (phase === 'game_over') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
      ctx.fillRect(0, 0, VIEW_WIDTH, VIEW_HEIGHT);

      ctx.fillStyle = '#ff0055';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SYSTEM DEFEATED', VIEW_WIDTH / 2, 380);

      ctx.fillStyle = '#ffffff';
      ctx.font = '16px sans-serif';
      ctx.fillText(`FINAL SCORE: ${score}`, VIEW_WIDTH / 2, 425);
    }

    ctx.restore();
  }

  function state() {
    return {
      phase,
      wave,
      score: Math.floor(score),
      entities: balls.length + hazards.length + mergeOrbs.length + particles.length,
      combo,
      game_over: gameOver,
      awaiting_revive: awaitingRevive
    };
  }

  // Unified Single-Thumb Touch / Pointer Interaction for Standalone Play
  function setupInputHandlers() {
    if (!canvas) return;
    let pointerDown = false;

    canvas.addEventListener('pointerdown', (e) => {
      pointerDown = true;
      const rect = canvas.getBoundingClientRect();
      const scaleX = VIEW_WIDTH / rect.width;
      const scaleY = VIEW_HEIGHT / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      step(16.67, { x, y, down: true, tap: false, choice: null });
    });

    window.addEventListener('pointermove', (e) => {
      if (!pointerDown) return;
      const rect = canvas.getBoundingClientRect();
      const scaleX = VIEW_WIDTH / rect.width;
      const scaleY = VIEW_HEIGHT / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      step(16.67, { x, y, down: true, tap: false, choice: null });
    });

    window.addEventListener('pointerup', (e) => {
      if (!pointerDown) return;
      pointerDown = false;
      const rect = canvas.getBoundingClientRect();
      const scaleX = VIEW_WIDTH / rect.width;
      const scaleY = VIEW_HEIGHT / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;
      step(16.67, { x, y, down: false, tap: true, choice: null });
    });
  }

  // Deterministic Bridge Export
  window.__GAME = {
    reset,
    step,
    state
  };

  // Auto-init on DOM loaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      reset(42);
      setupInputHandlers();
    });
  } else {
    reset(42);
    setupInputHandlers();
  }
})();
