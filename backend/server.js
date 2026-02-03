const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || '*';
const TURN_DELAY_MS = Number(process.env.TURN_DELAY_MS || 600);
const BOT_THINK_MIN = Number(process.env.BOT_THINK_MIN || 500);
const BOT_THINK_MAX = Number(process.env.BOT_THINK_MAX || 1200);
const UNO_WINDOW_MS = Number(process.env.UNO_WINDOW_MS || 2000);
const CHALLENGE_WINDOW_MS = Number(process.env.CHALLENGE_WINDOW_MS || 3000);
const DISCONNECT_TIMEOUT_MS = Number(process.env.DISCONNECT_TIMEOUT_MS || 30000);

const COLORS = ['red', 'yellow', 'green', 'blue'];
const ACTIONS = ['skip', 'reverse', 'draw2'];

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN, credentials: true }));
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST']
  }
});

const lobbies = new Map();
const socketPlayerMap = new Map();

function generateInviteCode(length = 5) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(Math.random() * alphabet.length);
    code += alphabet[idx];
  }
  if (lobbies.has(code)) return generateInviteCode(length);
  return code;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function createDeck() {
  const deck = [];
  COLORS.forEach((color) => {
    deck.push(makeCard({ type: 'number', color, value: 0 }));
    for (let v = 1; v <= 9; v += 1) {
      deck.push(makeCard({ type: 'number', color, value: v }));
      deck.push(makeCard({ type: 'number', color, value: v }));
    }
    ACTIONS.forEach((type) => {
      deck.push(makeCard({ type, color }));
      deck.push(makeCard({ type, color }));
    });
  });

  for (let i = 0; i < 4; i += 1) {
    deck.push(makeCard({ type: 'wild', color: null, value: null }));
    deck.push(makeCard({ type: 'wild4', color: null, value: null }));
  }

  return deck;
}

function makeCard({ type, color, value = null }) {
  return {
    id: crypto.randomUUID(),
    type,
    color,
    value
  };
}

function createPlayer(name, isBot = false) {
  return {
    id: crypto.randomUUID(),
    name: name || 'Player',
    isBot,
    connected: !isBot,
    socketId: null,
    hand: [],
    lastSeen: Date.now(),
    disconnectTimer: null,
    botTimer: null
  };
}

function getLobby(code) {
  return lobbies.get(code) || null;
}

function getPlayer(lobby, playerId) {
  return lobby.players.find((p) => p.id === playerId) || null;
}

function getPlayerIndex(lobby, playerId) {
  return lobby.players.findIndex((p) => p.id === playerId);
}

function nextIndex(lobby, fromIndex, steps = 1) {
  const len = lobby.players.length;
  if (len === 0) return 0;
  return (fromIndex + steps * lobby.game.direction + len) % len;
}

function drawCards(game, count) {
  const drawn = [];
  for (let i = 0; i < count; i += 1) {
    if (game.drawPile.length === 0) {
      reshuffle(game);
    }
    if (game.drawPile.length === 0) break;
    drawn.push(game.drawPile.pop());
  }
  return drawn;
}

function reshuffle(game) {
  if (game.discardPile.length <= 1) return;
  const top = game.discardPile.pop();
  game.drawPile = shuffle(game.discardPile);
  game.discardPile = [top];
}

function isPlayable(card, game) {
  if (!card || !game) return false;
  if (card.type === 'wild' || card.type === 'wild4') return true;

  const top = game.discardPile[game.discardPile.length - 1];
  if (!top) return false;

  if (card.color && card.color === game.currentColor) return true;
  if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
  if (['skip', 'reverse', 'draw2'].includes(card.type) && card.type === top.type) return true;
  return false;
}

function canPlayWild4(hand, game) {
  return !hand.some((c) => c.color === game.currentColor);
}

function isPlayableStrict(card, game, hand) {
  if (!isPlayable(card, game)) return false;
  if (card.type === 'wild4') return canPlayWild4(hand, game);
  return true;
}

function sendState(lobby) {
  lobby.players.forEach((player) => {
    if (!player.socketId) return;
    const view = buildPlayerView(lobby, player.id);
    io.to(player.socketId).emit('stateUpdate', view);
  });
}

function toast(lobby, message) {
  io.to(lobby.code).emit('toast', message);
}

function buildPlayerView(lobby, playerId) {
  const playerIndex = getPlayerIndex(lobby, playerId);
  const player = lobby.players[playerIndex];
  const game = lobby.game;

  const view = {
    code: lobby.code,
    phase: lobby.phase,
    hostId: lobby.hostId,
    you: player
      ? { id: player.id, name: player.name, index: playerIndex }
      : null,
    players: lobby.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      connected: p.connected,
      handCount: p.hand.length,
      isHost: p.id === lobby.hostId
    })),
    hand: player ? player.hand : []
  };

  if (game) {
    view.game = {
      discardTop: game.discardPile[game.discardPile.length - 1] || null,
      currentColor: game.currentColor,
      direction: game.direction,
      currentPlayerIndex: game.currentPlayerIndex,
      drawDeckCount: game.drawPile.length,
      discardPileCount: game.discardPile.length,
      pending: {
        awaitingColor: game.awaitingColor ? game.awaitingColor.playerId : null,
        pendingChallenge: game.pendingChallenge
          ? { challengerId: game.pendingChallenge.challengerId, expiresAt: game.pendingChallenge.expiresAt }
          : null,
        unoPending: game.unoPending
          ? { playerId: game.unoPending.playerId, expiresAt: game.unoPending.expiresAt }
          : null
      },
      winnerId: game.winnerId || null,
      isAdvancing: game.isAdvancing || false,
      drawnCardId: game.drawnCardIdByPlayer?.[playerId] || null
    };
  }

  return view;
}

function startUnoWindow(lobby, playerId) {
  const game = lobby.game;
  if (game.unoPending?.timer) {
    clearTimeout(game.unoPending.timer);
  }
  game.unoPending = {
    playerId,
    expiresAt: Date.now() + UNO_WINDOW_MS,
    called: false,
    timer: setTimeout(() => {
      if (game.unoPending && !game.unoPending.called) {
        game.unoPending = null;
        sendState(lobby);
      }
    }, UNO_WINDOW_MS)
  };
}

function clearUnoWindow(game) {
  if (game?.unoPending?.timer) {
    clearTimeout(game.unoPending.timer);
  }
  if (game) game.unoPending = null;
}

function scheduleAdvanceTurn(lobby, steps = 1, onAdvanced) {
  const game = lobby.game;
  if (game.isAdvancing) return;
  game.isAdvancing = true;
  const fromIndex = game.currentPlayerIndex;
  const next = nextIndex(lobby, fromIndex, steps);

  setTimeout(() => {
    game.currentPlayerIndex = next;
    game.isAdvancing = false;
    game.drawnCardIdByPlayer = {};
    if (typeof onAdvanced === 'function') {
      onAdvanced(next);
    }
    sendState(lobby);
    maybeScheduleBot(lobby);
  }, TURN_DELAY_MS);
}

function maybeScheduleBot(lobby) {
  const game = lobby.game;
  if (!game || lobby.phase !== 'playing') return;
  if (game.isAdvancing || game.awaitingColor || game.pendingChallenge) return;

  const player = lobby.players[game.currentPlayerIndex];
  if (!player || !player.isBot) return;

  if (player.botTimer) clearTimeout(player.botTimer);
  const delay = BOT_THINK_MIN + Math.random() * (BOT_THINK_MAX - BOT_THINK_MIN);
  player.botTimer = setTimeout(() => runBotTurn(lobby, player), delay);
}

function runBotTurn(lobby, player) {
  const game = lobby.game;
  if (!game || lobby.phase !== 'playing') return;
  if (game.isAdvancing || game.awaitingColor || game.pendingChallenge) return;

  const playerIndex = getPlayerIndex(lobby, player.id);
  if (playerIndex !== game.currentPlayerIndex) return;

  const playable = player.hand.filter((card) => isPlayableStrict(card, game, player.hand));
  let chosen = null;
  if (playable.length > 0) {
    chosen = chooseBotCard(playable, player.hand, game);
  }

  if (!chosen) {
    handleDraw(lobby, player, true);
    return;
  }

  let chosenColor = null;
  if (chosen.type === 'wild' || chosen.type === 'wild4') {
    chosenColor = chooseBotColor(player.hand);
  }
  handlePlay(lobby, player, chosen.id, chosenColor, true);
}

function chooseBotCard(playable, hand, game) {
  const hasNonWild = playable.some((c) => c.type !== 'wild' && c.type !== 'wild4');

  const scored = playable.map((card) => {
    let score = 0;
    if (card.type === 'draw2') score = 6;
    else if (card.type === 'skip') score = 5;
    else if (card.type === 'reverse') score = 4;
    else if (card.type === 'wild4') score = 3;
    else if (card.type === 'wild') score = 2;
    else score = 1;

    if (card.type === 'wild4' && hasNonWild) score -= 2;
    if (card.color === game.currentColor) score += 0.5;
    return { card, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const bestScore = scored[0].score;
  const best = scored.filter((s) => s.score === bestScore);
  return best[Math.floor(Math.random() * best.length)].card;
}

function chooseBotColor(hand) {
  const counts = COLORS.reduce((acc, color) => {
    acc[color] = 0;
    return acc;
  }, {});

  hand.forEach((card) => {
    if (card.color) counts[card.color] += 1;
  });

  let best = COLORS[0];
  COLORS.forEach((color) => {
    if (counts[color] > counts[best]) best = color;
  });

  return best;
}

function ensureBots(lobby) {
  let botNumber = lobby.players.filter((p) => p.isBot).length + 1;
  while (lobby.players.length < 4) {
    const bot = createPlayer(`Bot ${botNumber}`, true);
    lobby.players.push(bot);
    botNumber += 1;
  }
}

function startGame(lobby) {
  lobby.phase = 'playing';
  lobby.players.forEach((p) => {
    p.hand = [];
    p.connected = p.isBot ? false : p.connected;
  });

  const deck = shuffle(createDeck());
  const game = {
    drawPile: deck,
    discardPile: [],
    currentColor: null,
    direction: 1,
    currentPlayerIndex: 0,
    drawnCardIdByPlayer: {},
    awaitingColor: null,
    pendingChallenge: null,
    unoPending: null,
    isAdvancing: false,
    winnerId: null
  };

  // Deal cards
  lobby.players.forEach((player) => {
    player.hand = drawCards(game, 7);
  });

  // Start discard
  const first = drawCards(game, 1)[0];
  game.discardPile.push(first);

  if (first.type === 'wild' || first.type === 'wild4') {
    game.currentColor = COLORS[Math.floor(Math.random() * COLORS.length)];
  } else {
    game.currentColor = first.color;
  }

  lobby.game = game;

  applyStartCardEffect(lobby, first);
  sendState(lobby);
  maybeScheduleBot(lobby);
}

function applyStartCardEffect(lobby, firstCard) {
  const game = lobby.game;
  const len = lobby.players.length;
  if (!firstCard) return;

  if (firstCard.type === 'skip') {
    toast(lobby, 'First card is Skip. First player is skipped.');
    game.currentPlayerIndex = nextIndex(lobby, 0, 2);
  } else if (firstCard.type === 'reverse') {
    toast(lobby, 'First card is Reverse. Direction changes.');
    if (len === 2) {
      game.currentPlayerIndex = nextIndex(lobby, 0, 2);
    } else {
      game.direction *= -1;
      game.currentPlayerIndex = nextIndex(lobby, 0, 1);
    }
  } else if (firstCard.type === 'draw2') {
    const targetIndex = nextIndex(lobby, 0, 1);
    const target = lobby.players[targetIndex];
    target.hand.push(...drawCards(game, 2));
    toast(lobby, `${target.name} draws 2 to start.`);
    game.currentPlayerIndex = nextIndex(lobby, 0, 2);
  } else {
    game.currentPlayerIndex = 0;
  }
}

function endGame(lobby, winnerId) {
  lobby.phase = 'finished';
  lobby.game.winnerId = winnerId;
  clearUnoWindow(lobby.game);
  if (lobby.game.pendingChallenge?.timer) {
    clearTimeout(lobby.game.pendingChallenge.timer);
  }
  lobby.game.pendingChallenge = null;
  lobby.game.awaitingColor = null;
  lobby.game.isAdvancing = false;
  sendState(lobby);
}

function handlePlay(lobby, player, cardId, chosenColor, isBot = false) {
  const game = lobby.game;
  if (lobby.phase !== 'playing') return { ok: false, error: 'Game not started.' };
  if (game.isAdvancing) return { ok: false, error: 'Turn is advancing.' };
  if (game.awaitingColor) return { ok: false, error: 'Waiting for color choice.' };
  if (game.pendingChallenge) return { ok: false, error: 'Resolve the challenge first.' };

  const playerIndex = getPlayerIndex(lobby, player.id);
  if (playerIndex !== game.currentPlayerIndex) return { ok: false, error: 'Not your turn.' };

  const card = player.hand.find((c) => c.id === cardId);
  if (!card) return { ok: false, error: 'Card not found.' };

  if (game.drawnCardIdByPlayer[player.id] && game.drawnCardIdByPlayer[player.id] !== cardId) {
    return { ok: false, error: 'You must play the drawn card or pass.' };
  }

  const wild4Legal = card.type === 'wild4' ? canPlayWild4(player.hand, game) : true;
  if (card.type === 'wild4' && !wild4Legal) {
    return { ok: false, error: 'Wild Draw Four is only legal if you have no card of the current color.' };
  }

  if (!isPlayableStrict(card, game, player.hand)) return { ok: false, error: 'Illegal play.' };

  player.hand = player.hand.filter((c) => c.id !== cardId);
  game.discardPile.push(card);
  delete game.drawnCardIdByPlayer[player.id];

  if (player.hand.length === 0) {
    toast(lobby, `${player.name} wins!`);
    endGame(lobby, player.id);
    return { ok: true };
  }

  if (player.hand.length === 1) {
    startUnoWindow(lobby, player.id);
  }

  if (card.type === 'wild' || card.type === 'wild4') {
    if (chosenColor) {
      applyWildChoice(lobby, playerIndex, card.type, chosenColor, wild4Legal);
      sendState(lobby);
      return { ok: true };
    }
    game.awaitingColor = {
      playerId: player.id,
      cardType: card.type,
      wild4Legal,
      playedByIndex: playerIndex
    };
    sendState(lobby);
    return { ok: true };
  }

  game.currentColor = card.color;
  applyCardEffect(lobby, card, playerIndex);
  sendState(lobby);
  return { ok: true };
}

function applyWildChoice(lobby, playerIndex, cardType, chosenColor, wild4Legal) {
  const game = lobby.game;
  if (!COLORS.includes(chosenColor)) return;
  game.currentColor = chosenColor;
  game.awaitingColor = null;

  if (cardType === 'wild4') {
    scheduleAdvanceTurn(lobby, 1, (nextIndexValue) => {
      startWild4Challenge(lobby, nextIndexValue, lobby.players[playerIndex].id, wild4Legal);
    });
  } else {
    scheduleAdvanceTurn(lobby, 1);
  }
}

function applyCardEffect(lobby, card, playerIndex) {
  const game = lobby.game;
  const len = lobby.players.length;

  if (card.type === 'number') {
    scheduleAdvanceTurn(lobby, 1);
    return;
  }

  if (card.type === 'skip') {
    scheduleAdvanceTurn(lobby, 2);
    toast(lobby, 'Next player skipped.');
    return;
  }

  if (card.type === 'reverse') {
    if (len === 2) {
      scheduleAdvanceTurn(lobby, 2);
      toast(lobby, 'Reverse acts as Skip with 2 players.');
    } else {
      game.direction *= -1;
      scheduleAdvanceTurn(lobby, 1);
      toast(lobby, 'Direction reversed.');
    }
    return;
  }

  if (card.type === 'draw2') {
    const targetIndex = nextIndex(lobby, playerIndex, 1);
    const target = lobby.players[targetIndex];
    target.hand.push(...drawCards(game, 2));
    toast(lobby, `${target.name} draws 2.`);
    scheduleAdvanceTurn(lobby, 2);
  }
}

function startWild4Challenge(lobby, challengerIndex, playedById, legal) {
  const game = lobby.game;
  if (!game) return;

  const challenger = lobby.players[challengerIndex];
  if (!challenger) return;

  if (game.pendingChallenge?.timer) clearTimeout(game.pendingChallenge.timer);
  game.pendingChallenge = {
    challengerId: challenger.id,
    playedById,
    legal,
    expiresAt: Date.now() + CHALLENGE_WINDOW_MS,
    timer: setTimeout(() => resolveWild4Challenge(lobby, false), CHALLENGE_WINDOW_MS)
  };

  sendState(lobby);

  if (challenger.isBot) {
    const delay = BOT_THINK_MIN + Math.random() * (BOT_THINK_MAX - BOT_THINK_MIN);
    setTimeout(() => {
      const shouldChallenge = Math.random() < 0.35;
      resolveWild4Challenge(lobby, shouldChallenge);
    }, delay);
  }
}

function resolveWild4Challenge(lobby, challenged) {
  const game = lobby.game;
  if (!game || !game.pendingChallenge) return;

  const { challengerId, playedById, legal, timer } = game.pendingChallenge;
  if (timer) clearTimeout(timer);

  const challenger = getPlayer(lobby, challengerId);
  const playedBy = getPlayer(lobby, playedById);

  game.pendingChallenge = null;

  if (!challenger || !playedBy) {
    sendState(lobby);
    return;
  }

  if (challenged) {
    if (legal) {
      challenger.hand.push(...drawCards(game, 6));
      toast(lobby, `${challenger.name} challenged and draws 6.`);
      scheduleAdvanceTurn(lobby, 1);
    } else {
      playedBy.hand.push(...drawCards(game, 4));
      toast(lobby, `${challenger.name} challenged successfully. ${playedBy.name} draws 4.`);
      sendState(lobby);
      maybeScheduleBot(lobby);
    }
  } else {
    challenger.hand.push(...drawCards(game, 4));
    toast(lobby, `${challenger.name} draws 4.`);
    scheduleAdvanceTurn(lobby, 1);
  }
}

function handleDraw(lobby, player, isBot = false) {
  const game = lobby.game;
  if (lobby.phase !== 'playing') return { ok: false, error: 'Game not started.' };
  if (game.isAdvancing) return { ok: false, error: 'Turn is advancing.' };
  if (game.awaitingColor) return { ok: false, error: 'Waiting for color choice.' };
  if (game.pendingChallenge) return { ok: false, error: 'Resolve the challenge first.' };

  const playerIndex = getPlayerIndex(lobby, player.id);
  if (playerIndex !== game.currentPlayerIndex) return { ok: false, error: 'Not your turn.' };

  if (game.drawnCardIdByPlayer[player.id]) return { ok: false, error: 'Already drew this turn.' };

  const card = drawCards(game, 1)[0];
  if (!card) return { ok: false, error: 'Deck empty.' };

  player.hand.push(card);
  game.drawnCardIdByPlayer[player.id] = card.id;

  toast(lobby, `${player.name} drew a card.`);

  if (!isPlayableStrict(card, game, player.hand)) {
    toast(lobby, `${player.name} cannot play. Turn ends.`);
    scheduleAdvanceTurn(lobby, 1);
  } else if (player.isBot) {
    setTimeout(() => {
      handlePlay(lobby, player, card.id, card.type.startsWith('wild') ? chooseBotColor(player.hand) : null, true);
    }, 300);
  }

  sendState(lobby);
  return { ok: true };
}

function handlePass(lobby, player) {
  const game = lobby.game;
  if (!game) return { ok: false, error: 'Game not started.' };
  const playerIndex = getPlayerIndex(lobby, player.id);
  if (playerIndex !== game.currentPlayerIndex) return { ok: false, error: 'Not your turn.' };
  if (!game.drawnCardIdByPlayer[player.id]) return { ok: false, error: 'You must draw first.' };
  delete game.drawnCardIdByPlayer[player.id];
  scheduleAdvanceTurn(lobby, 1);
  sendState(lobby);
  return { ok: true };
}

function handleDisconnect(socketId) {
  const entry = socketPlayerMap.get(socketId);
  if (!entry) return;
  socketPlayerMap.delete(socketId);

  const lobby = lobbies.get(entry.code);
  if (!lobby) return;

  const player = getPlayer(lobby, entry.playerId);
  if (!player) return;

  player.connected = false;
  player.socketId = null;
  player.lastSeen = Date.now();

  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);

  if (lobby.phase === 'playing') {
    player.disconnectTimer = setTimeout(() => {
      if (player.connected) return;
      player.isBot = true;
      player.name = player.name.includes('(Bot)') ? player.name : `${player.name} (Bot)`;
      toast(lobby, `${player.name} is now a bot.`);
      sendState(lobby);
      maybeScheduleBot(lobby);
    }, DISCONNECT_TIMEOUT_MS);
  } else {
    player.disconnectTimer = setTimeout(() => {
      if (player.connected) return;
      lobby.players = lobby.players.filter((p) => p.id !== player.id);
      if (lobby.hostId === player.id && lobby.players.length > 0) {
        lobby.hostId = lobby.players[0].id;
      }
      if (lobby.players.length === 0) {
        lobbies.delete(lobby.code);
      } else {
        sendState(lobby);
      }
    }, DISCONNECT_TIMEOUT_MS);
  }

  sendState(lobby);
}

io.on('connection', (socket) => {
  socket.on('createLobby', (payload, cb) => {
    const name = payload?.name?.trim() || 'Player';
    const code = generateInviteCode();
    const player = createPlayer(name, false);
    player.connected = true;
    player.socketId = socket.id;

    const lobby = {
      code,
      hostId: player.id,
      players: [player],
      phase: 'lobby',
      game: null
    };

    lobbies.set(code, lobby);
    socket.join(code);
    socketPlayerMap.set(socket.id, { code, playerId: player.id });

    sendState(lobby);
    cb?.({ ok: true, code, playerId: player.id });
  });

  socket.on('joinLobby', (payload, cb) => {
    const code = payload?.code?.trim().toUpperCase();
    const lobby = getLobby(code);
    if (!lobby) {
      cb?.({ ok: false, error: 'Lobby not found.' });
      return;
    }

    const playerId = payload?.playerId;
    if (playerId) {
      const existing = getPlayer(lobby, playerId);
      if (existing) {
        existing.connected = true;
        existing.socketId = socket.id;
        existing.lastSeen = Date.now();
        if (payload?.name) existing.name = payload.name;
        if (existing.isBot) {
          existing.isBot = false;
          existing.name = payload?.name || existing.name.replace(/\s*\(Bot\)$/i, '');
        }
        if (existing.botTimer) clearTimeout(existing.botTimer);
        if (existing.disconnectTimer) clearTimeout(existing.disconnectTimer);

        socket.join(code);
        socketPlayerMap.set(socket.id, { code, playerId: existing.id });
        sendState(lobby);
        cb?.({ ok: true, code, playerId: existing.id });
        return;
      }
    }

    if (lobby.players.length >= 4) {
      cb?.({ ok: false, error: 'Lobby is full.' });
      return;
    }

    const name = payload?.name?.trim() || 'Player';
    const player = createPlayer(name, false);
    player.connected = true;
    player.socketId = socket.id;
    lobby.players.push(player);

    socket.join(code);
    socketPlayerMap.set(socket.id, { code, playerId: player.id });

    sendState(lobby);
    cb?.({ ok: true, code, playerId: player.id });
  });

  socket.on('startGame', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });

    if (payload?.playerId !== lobby.hostId) {
      return cb?.({ ok: false, error: 'Only host can start.' });
    }

    ensureBots(lobby);
    startGame(lobby);
    cb?.({ ok: true });
  });

  socket.on('addBot', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    if (payload?.playerId !== lobby.hostId) return cb?.({ ok: false, error: 'Only host can add bots.' });
    if (lobby.phase !== 'lobby') return cb?.({ ok: false, error: 'Game already started.' });
    if (lobby.players.length >= 4) return cb?.({ ok: false, error: 'Lobby full.' });

    const bot = createPlayer(`Bot ${lobby.players.filter((p) => p.isBot).length + 1}`, true);
    lobby.players.push(bot);
    sendState(lobby);
    cb?.({ ok: true });
  });

  socket.on('removeBot', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    if (payload?.playerId !== lobby.hostId) return cb?.({ ok: false, error: 'Only host can remove bots.' });
    if (lobby.phase !== 'lobby') return cb?.({ ok: false, error: 'Game already started.' });

    const botIndex = lobby.players.findIndex((p) => p.isBot);
    if (botIndex === -1) return cb?.({ ok: false, error: 'No bots to remove.' });

    lobby.players.splice(botIndex, 1);
    sendState(lobby);
    cb?.({ ok: true });
  });

  socket.on('playCard', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });

    const player = getPlayer(lobby, payload?.playerId);
    if (!player) return cb?.({ ok: false, error: 'Player not found.' });

    const result = handlePlay(lobby, player, payload?.cardId, payload?.chosenColor || null, false);
    cb?.(result);
  });

  socket.on('chooseColor', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });

    const player = getPlayer(lobby, payload?.playerId);
    if (!player) return cb?.({ ok: false, error: 'Player not found.' });
    const game = lobby.game;
    if (!game?.awaitingColor || game.awaitingColor.playerId !== player.id) {
      return cb?.({ ok: false, error: 'No color choice pending.' });
    }
    if (!COLORS.includes(payload?.color)) {
      return cb?.({ ok: false, error: 'Invalid color.' });
    }

    applyWildChoice(lobby, game.awaitingColor.playedByIndex, game.awaitingColor.cardType, payload?.color, game.awaitingColor.wild4Legal);
    sendState(lobby);
    cb?.({ ok: true });
  });

  socket.on('drawCard', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    const player = getPlayer(lobby, payload?.playerId);
    if (!player) return cb?.({ ok: false, error: 'Player not found.' });
    const result = handleDraw(lobby, player, false);
    cb?.(result);
  });

  socket.on('passTurn', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    const player = getPlayer(lobby, payload?.playerId);
    if (!player) return cb?.({ ok: false, error: 'Player not found.' });
    const result = handlePass(lobby, player);
    cb?.(result);
  });

  socket.on('callUNO', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    const game = lobby.game;
    if (!game?.unoPending) return cb?.({ ok: false, error: 'No UNO to call.' });
    if (game.unoPending.playerId !== payload?.playerId) {
      return cb?.({ ok: false, error: 'Not your UNO.' });
    }
    game.unoPending.called = true;
    clearUnoWindow(game);
    toast(lobby, 'UNO called!');
    sendState(lobby);
    cb?.({ ok: true });
  });

  socket.on('catchUNO', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    const game = lobby.game;
    if (!game?.unoPending) return cb?.({ ok: false, error: 'No UNO to catch.' });
    if (game.unoPending.playerId === payload?.playerId) {
      return cb?.({ ok: false, error: 'You cannot catch yourself.' });
    }
    const target = getPlayer(lobby, game.unoPending.playerId);
    if (!target) return cb?.({ ok: false, error: 'Player not found.' });
    target.hand.push(...drawCards(game, 2));
    toast(lobby, `${target.name} forgot UNO and draws 2.`);
    clearUnoWindow(game);
    sendState(lobby);
    cb?.({ ok: true });
  });

  socket.on('challengeWildDrawFour', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    const game = lobby.game;
    if (!game?.pendingChallenge) return cb?.({ ok: false, error: 'No challenge pending.' });
    if (game.pendingChallenge.challengerId !== payload?.playerId) {
      return cb?.({ ok: false, error: 'Not your challenge.' });
    }
    resolveWild4Challenge(lobby, true);
    cb?.({ ok: true });
  });

  socket.on('declineChallenge', (payload, cb) => {
    const lobby = getLobby(payload?.code);
    if (!lobby) return cb?.({ ok: false, error: 'Lobby not found.' });
    const game = lobby.game;
    if (!game?.pendingChallenge) return cb?.({ ok: false, error: 'No challenge pending.' });
    if (game.pendingChallenge.challengerId !== payload?.playerId) {
      return cb?.({ ok: false, error: 'Not your challenge.' });
    }
    resolveWild4Challenge(lobby, false);
    cb?.({ ok: true });
  });

  socket.on('disconnect', () => handleDisconnect(socket.id));
});

if (process.env.NODE_ENV === 'production') {
  const clientPath = path.join(__dirname, '../frontend/dist');
  app.use(express.static(clientPath));
  app.get('*', (_req, res) => res.sendFile(path.join(clientPath, 'index.html')));
}

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`UNO server running on port ${PORT}`);
});
