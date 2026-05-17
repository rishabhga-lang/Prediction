const SUITS = {
  H: { name: 'Hearts', symbol: '♥', color: 'red' },
  D: { name: 'Diamonds', symbol: '♦', color: 'red' },
  C: { name: 'Clubs', symbol: '♣', color: 'black' },
  S: { name: 'Spades', symbol: '♠', color: 'black' },
};

const TRUMP_ROTATION_LABEL = 'Spades → Hearts → Clubs → Diamonds';

const socket = io();
let myId = null;
let roomCode = null;
let isHost = false;
let gameState = null;
let predValue = 0;

const $ = (sel) => document.querySelector(sel);

function showScreen(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  $(`#${id}`)?.classList.add('active');
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function getName() {
  return ($('#input-name').value || 'Player').trim().slice(0, 20) || 'Player';
}

function createCardEl(card, opts = {}) {
  const {
    faceDown = false,
    mini = false,
    index = null,
    playable = false,
    disabled = false,
    trumpSuit = null,
  } = opts;
  const el = document.createElement('div');
  el.className = 'playing-card';

  if (mini) el.classList.add('mini');
  if (faceDown) {
    el.classList.add('card-back');
    return el;
  }

  const suit = SUITS[card.suit];
  el.classList.add(suit.color);
  if (trumpSuit && card.suit === trumpSuit) el.classList.add('trump-card');
  if (['J', 'Q', 'K'].includes(card.rank)) el.classList.add(`face-${card.rank}`);

  if (playable) el.classList.add('playable');
  if (disabled) el.classList.add('disabled');
  if (index != null) el.dataset.index = index;

  const rankLabel = card.rank === '10' ? '10' : card.rank;

  el.innerHTML = `
    <div class="corner top">
      <span class="rank">${rankLabel}</span>
      <span class="suit-icon">${suit.symbol}</span>
    </div>
    <span class="center-suit">${suit.symbol}</span>
    <div class="corner bottom">
      <span class="rank">${rankLabel}</span>
      <span class="suit-icon">${suit.symbol}</span>
    </div>
  `;

  return el;
}

function renderHand(state) {
  const handEl = $('#my-hand');
  handEl.innerHTML = '';

  const isMyTurn = state.currentPlayerId === state.myId;
  const leadSuit = state.leadSuit;
  const hasLead =
    leadSuit && state.hand.some((c) => c.suit === leadSuit);

  state.hand.forEach((card, i) => {
    let playable = false;
    let disabled = false;

    if (state.status === 'playing_trick' && isMyTurn) {
      if (hasLead) {
        playable = card.suit === leadSuit;
        disabled = !playable;
      } else {
        playable = true;
      }
    }

    const el = createCardEl(card, {
      index: i,
      playable,
      disabled: state.status === 'playing_trick' && isMyTurn && disabled,
      trumpSuit: state.trumpSuit,
    });

    if (playable) {
      el.addEventListener('click', () => {
        socket.emit('playCard', { cardIndex: i });
      });
    }

    handEl.appendChild(el);
  });
}

function renderOpponents(state) {
  const container = $('#opponents');
  container.innerHTML = '';

  state.players
    .filter((p) => p.id !== state.myId)
    .forEach((p) => {
      const div = document.createElement('div');
      div.className = 'opponent';
      const isActive =
        state.status === 'predicting'
          ? p.id === state.predictionTurnPlayerId
          : p.id === state.currentPlayerId;
      if (isActive) div.classList.add('active-turn');

      const count = state.handCount[p.id] ?? 0;
      const wins = state.wins[p.id] ?? 0;
      const pred = state.predictions[p.id];

      let predText = '';
      if (state.status === 'predicting') {
        if (pred?.submitted) {
          predText = `predicted ${pred.value}`;
        } else if (p.id === state.predictionTurnPlayerId) {
          predText = 'predicting now…';
        } else {
          predText = 'waiting…';
        }
      } else if (pred?.value !== undefined) {
        predText = `pred: ${pred.value}`;
      }

      const backs = document.createElement('div');
      backs.className = 'card-backs';
      const showCount = Math.min(count, 5);
      for (let i = 0; i < showCount; i++) {
        backs.appendChild(createCardEl(null, { faceDown: true, mini: true }));
      }
      if (count > 5) {
        const more = document.createElement('span');
        more.textContent = `+${count - 5}`;
        more.style.fontSize = '0.7rem';
        more.style.marginLeft = '4px';
        backs.appendChild(more);
      }

      const nameEl = document.createElement('div');
      nameEl.className = 'name';
      nameEl.textContent = p.name;
      const metaEl = document.createElement('div');
      metaEl.className = 'meta';
      metaEl.textContent = `${count} cards · ${wins} won${predText ? ' · ' + predText : ''}`;
      div.appendChild(nameEl);
      div.appendChild(metaEl);
      div.appendChild(backs);
      container.appendChild(div);
    });
}

function renderTrick(state) {
  const area = $('#trick-area');
  area.innerHTML = '';

  const entries = Object.entries(state.trick || {});
  if (entries.length === 0) return;

  entries.forEach(([pid, data]) => {
    const wrap = document.createElement('div');
    wrap.className = 'trick-play';
    const label = document.createElement('div');
    label.className = 'player-label';
    label.textContent = data.playerName;
    wrap.appendChild(label);
    wrap.appendChild(
      createCardEl(data.card, { trumpSuit: gameState?.trumpSuit })
    );
    area.appendChild(wrap);
  });
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderPhaseMessage(state) {
  const msg = $('#phase-message');
  const current = state.players.find((p) => p.id === state.currentPlayerId);

  if (state.status === 'predicting') {
    const turn = state.players.find((p) => p.id === state.predictionTurnPlayerId);
    if (state.predictionTurnPlayerId === state.myId) {
      msg.textContent = 'Your turn to predict';
    } else if (turn) {
      msg.textContent = `${turn.name} is predicting…`;
    } else if (state.myPrediction !== undefined) {
      msg.textContent = 'All predictions in — starting tricks…';
    } else {
      msg.textContent = 'Waiting for players ahead of you…';
    }
    return;
  }

  if (state.status === 'playing_trick') {
    if (state.currentPlayerId === state.myId) {
      msg.textContent = leadSuitMessage(state);
    } else {
      const leader = state.players.find((p) => p.id === state.trickLeaderId);
      const leading = state.subround === 1 && !state.leadSuit;
      if (leading && leader) {
        msg.textContent = `${leader.name} leads · ${current?.name ?? 'Someone'}'s turn`;
      } else {
        msg.textContent = `${current?.name ?? 'Someone'}'s turn`;
      }
    }
    return;
  }

  if (state.status === 'round_end') {
    msg.textContent = 'Round complete';
    return;
  }

  msg.textContent = '';
}

function leadSuitMessage(state) {
  if (state.leadSuit) {
    const sym = SUITS[state.leadSuit].symbol;
    return `Your turn — follow ${sym} if you can`;
  }
  return 'Your turn — lead any card';
}

function renderMyStats(state) {
  const el = $('#my-stats');
  const wins = state.wins[state.myId] ?? 0;
  const pred =
    state.myPrediction !== undefined
      ? state.myPrediction
      : state.predictions[state.myId]?.value;

  el.innerHTML = `
    <span>Your prediction: <strong>${pred ?? '—'}</strong></span>
    <span>Tricks won: <strong>${wins}</strong></span>
    <span>Score: <strong>${state.scores[state.myId] ?? 0}</strong></span>
  `;
}

function updateRoundLabels(state) {
  $('#round-label').textContent = `Round ${state.roundNum} / ${state.totalRounds}`;
  const trickNum = Math.max(1, state.subround || 1);
  $('#trick-label').textContent = `Trick ${trickNum} / ${state.cardsPerPlayer}`;
}

function updateTrumpBadge(state) {
  const suit = SUITS[state.trumpSuit] ?? SUITS.S;
  const name = state.trumpName ?? suit.name;
  const badge = $('#trump-badge');
  if (!badge) return;
  badge.innerHTML = `Trump: <span class="trump-symbol ${suit.color}">${suit.symbol}</span> ${name}`;
}

function renderScores(state) {
  const list = $('#scores-list');
  list.innerHTML = '';
  const sorted = [...state.players].sort(
    (a, b) => (state.scores[b.id] ?? 0) - (state.scores[a.id] ?? 0)
  );
  sorted.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}</span><strong>${state.scores[p.id] ?? 0}</strong>`;
    list.appendChild(li);
  });
}

function renderPredictionsBoard(state) {
  const board = $('#predictions-board');
  const list = $('#predictions-queue');
  if (!board || !list) return;

  const predicting = state.status === 'predicting';
  board.classList.toggle('hidden', !predicting);
  if (!predicting) {
    list.innerHTML = '';
    return;
  }

  list.innerHTML = '';
  (state.predictionQueue ?? []).forEach((entry) => {
    const li = document.createElement('li');
    let statusText;
    if (entry.submitted) {
      li.classList.add('done');
      statusText = `<span class="pred-val">${entry.value}</span>`;
    } else if (entry.isCurrent) {
      li.classList.add('current');
      statusText = '<span>predicting…</span>';
    } else {
      li.classList.add('waiting');
      statusText = '<span>—</span>';
    }
    li.innerHTML = `<span>${escapeHtml(entry.name)}</span>${statusText}`;
    list.appendChild(li);
  });
}

function showPredictionModal(state) {
  const modal = $('#prediction-modal');
  const max = state.cardsPerPlayer;
  const isMyTurn = state.predictionTurnPlayerId === state.myId;
  const predicting = state.status === 'predicting';

  $('#pred-max').textContent = max;

  if (state.myPrediction !== undefined) {
    $('#btn-submit-pred').classList.add('hidden');
    $('#pred-waiting').classList.remove('hidden');
    predValue = state.myPrediction;
  } else if (isMyTurn) {
    $('#btn-submit-pred').classList.remove('hidden');
    $('#pred-waiting').classList.add('hidden');
    predValue = Math.min(predValue, max);
  } else {
    $('#btn-submit-pred').classList.add('hidden');
    $('#pred-waiting').classList.remove('hidden');
    $('#pred-waiting').textContent = 'Wait for your turn…';
  }

  if (isMyTurn && state.myPrediction === undefined) {
    $('#pred-waiting').classList.add('hidden');
    $('#pred-modal-title').textContent = 'Your prediction';
    $('#pred-modal-desc').textContent =
      'Players before you have locked in. How many tricks will you win?';
  }

  $('#pred-value').textContent = predValue;
  modal.classList.toggle('hidden', !predicting || !isMyTurn || state.myPrediction !== undefined);
}

function applyGameState(state) {
  gameState = state;
  showScreen('screen-game');

  if (state.status === 'predicting') {
    predValue = 0;
    $('#round-modal').classList.add('hidden');
  }

  if (state.status !== 'round_end') {
    $('#round-modal').classList.add('hidden');
  }

  updateRoundLabels(state);
  updateTrumpBadge(state);
  renderPhaseMessage(state);
  renderPredictionsBoard(state);
  renderOpponents(state);
  renderTrick(state);
  renderHand(state);
  renderMyStats(state);
  renderScores(state);
  showPredictionModal(state);

  if (state.status === 'round_end') {
    $('#round-modal').classList.remove('hidden');
  }
}

// Events
$('#btn-create').addEventListener('click', () => {
  socket.emit('createRoom', { name: getName() });
});

$('#btn-join').addEventListener('click', () => {
  const code = $('#input-code').value.trim().toUpperCase();
  if (code.length < 4) {
    toast('Enter a valid room code');
    return;
  }
  socket.emit('joinRoom', { code, name: getName() });
});

$('#btn-copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    toast('Room code copied!');
  } catch {
    toast('Copy failed — share manually: ' + roomCode);
  }
});

$('#btn-start').addEventListener('click', () => {
  socket.emit('startGame');
});

document.querySelectorAll('.btn-pred').forEach((btn) => {
  btn.addEventListener('click', () => {
    const delta = Number(btn.dataset.delta);
    const max = gameState?.cardsPerPlayer ?? 0;
    predValue = Math.max(0, Math.min(max, predValue + delta));
    $('#pred-value').textContent = predValue;
  });
});

$('#btn-submit-pred').addEventListener('click', () => {
  socket.emit('submitPrediction', { value: predValue });
});

$('#btn-scores').addEventListener('click', () => {
  $('#scores-drawer').classList.remove('hidden');
});

$('#btn-close-scores').addEventListener('click', () => {
  $('#scores-drawer').classList.add('hidden');
});

$('#btn-next-round').addEventListener('click', () => {
  socket.emit('nextRound');
  $('#round-modal').classList.add('hidden');
});

socket.on('joined', (data) => {
  myId = data.playerId;
  roomCode = data.roomCode;
  isHost = data.isHost;
  $('#display-room-code').textContent = roomCode;
  showScreen('screen-lobby');
});

socket.on('lobbyUpdate', (data) => {
  roomCode = data.code;
  $('#display-room-code').textContent = roomCode;
  $('#player-count').textContent = data.players.length;

  const list = $('#lobby-players');
  list.innerHTML = '';
  data.players.forEach((p) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(p.name)}</span>${p.isHost ? '<span class="host-badge">Host</span>' : ''}`;
    list.appendChild(li);
  });

  const canStart = myId === data.hostId && data.players.length >= 2;
  $('#btn-start').classList.toggle('hidden', !canStart);
  $('#waiting-host').classList.toggle('hidden', canStart || myId === data.hostId);
});

socket.on('gameState', (state) => {
  applyGameState(state);
});

socket.on('cardPlayed', (data) => {
  if (data.trickComplete) {
    toast(`${data.winnerName} wins the trick!`);
  }
});

socket.on('roundEnd', (results) => {
  const list = $('#round-results-list');
  list.innerHTML = '';

  const sorted = Object.entries(results).sort(
    (a, b) => b[1].points - a[1].points
  );

  sorted.forEach(([, r]) => {
    const li = document.createElement('li');
    li.className = r.correct ? 'correct' : 'wrong';
    const sign = r.points >= 0 ? '+' : '';
    li.innerHTML = `
      <strong>${escapeHtml(r.name)}</strong><br/>
      Predicted ${r.pred}, won ${r.actual} → <strong>${sign}${r.points}</strong> pts
    `;
    list.appendChild(li);
  });

  $('#round-modal').classList.remove('hidden');
  const host = gameState?.isHost;
  $('#btn-next-round').classList.toggle('hidden', !host);
  $('#round-wait-host').classList.toggle('hidden', host);
});

socket.on('gameOver', (data) => {
  const ol = $('#final-standings');
  ol.innerHTML = '';
  data.standings.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${i + 1}. ${escapeHtml(p.name)}</span><strong>${p.score}</strong>`;
    ol.appendChild(li);
  });
  $('#gameover-modal').classList.remove('hidden');
});

socket.on('error', (data) => {
  toast(data.message || 'Error');
});

socket.on('playerJoined', (data) => {
  toast(`${data.name} joined the room`);
});
