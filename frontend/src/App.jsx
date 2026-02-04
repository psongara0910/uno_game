import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_LABELS = {
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue'
};

const UNO_COLORS = {
  red: '#e53935',
  yellow: '#f6c026',
  green: '#2abf6a',
  blue: '#2f7bf2',
  black: '#111'
};

const SERVER_URL = import.meta.env.VITE_SERVER_URL || window.location.origin;

function App() {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [state, setState] = useState(null);
  const [name, setName] = useState(localStorage.getItem('uno_name') || '');
  const [codeInput, setCodeInput] = useState('');
  const [error, setError] = useState('');
  const [toasts, setToasts] = useState([]);
  const [colorPicker, setColorPicker] = useState({ open: false, cardId: null });
  const [animatingCardId, setAnimatingCardId] = useState(null);
  const [drawAnimating, setDrawAnimating] = useState(false);
  const [penaltyPops, setPenaltyPops] = useState({});
  const [seatShakes, setSeatShakes] = useState({});
  const [cardRain, setCardRain] = useState({});
  const stateRef = useRef(null);

  const addToast = (message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((prev) => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2600);
  };

  useEffect(() => {
    const s = io(SERVER_URL, { transports: ['websocket'] });
    setSocket(s);

    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));
    s.on('stateUpdate', (view) => {
      setState(view);
      setError('');
    });
    s.on('toast', (msg) => {
      addToast(msg);
      const penalty = parsePenaltyToast(msg, stateRef.current?.players || []);
      if (penalty) {
        pushPenaltyPop(penalty.playerId, penalty.value, setPenaltyPops, setSeatShakes);
        spawnCardRain(penalty.playerId, penalty.value, setCardRain);
      }
    });
    s.on('errorMessage', (msg) => setError(msg));

    return () => s.disconnect();
  }, []);

  const meId = state?.you?.id || null;
  const myIndex = state?.you?.index ?? -1;
  const game = state?.game;
  const myTurn = game && myIndex === game.currentPlayerIndex;
  const awaitingColor = game?.pending?.awaitingColor;
  const pendingChallenge = game?.pending?.pendingChallenge;
  const unoPending = game?.pending?.unoPending;
  const drawnCardId = game?.drawnCardId;
  const isAdvancing = game?.isAdvancing;

  const canAct = !!game && myTurn && !isAdvancing && !awaitingColor && !pendingChallenge;

  const emitAction = (event, payload) => {
    if (!socket) return;
    socket.emit(event, payload, (res) => {
      if (res && !res.ok) {
        addToast(res.error || 'Action failed');
      }
    });
  };

  const handleCreate = () => {
    if (!name.trim()) {
      setError('Please enter a name');
      return;
    }
    localStorage.setItem('uno_name', name.trim());
    emitAction('createLobby', { name: name.trim() });
  };

  const handleJoin = () => {
    if (!name.trim()) {
      setError('Please enter a name');
      return;
    }
    if (!codeInput.trim()) {
      setError('Enter an invite code');
      return;
    }
    localStorage.setItem('uno_name', name.trim());
    emitAction('joinLobby', {
      code: codeInput.trim().toUpperCase(),
      name: name.trim(),
      playerId: localStorage.getItem('uno_playerId') || null
    });
  };

  const handleReconnect = () => {
    const code = localStorage.getItem('uno_code');
    const playerId = localStorage.getItem('uno_playerId');
    if (!code || !playerId) return;
    emitAction('joinLobby', { code, playerId, name: name.trim() || 'Player' });
  };

  useEffect(() => {
    if (!state?.you?.id) return;
    localStorage.setItem('uno_playerId', state.you.id);
    if (state.code) localStorage.setItem('uno_code', state.code);
  }, [state?.you?.id, state?.code]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const isHost = state?.hostId && state?.hostId === meId;

  const handleStart = () => {
    emitAction('startGame', { code: state.code, playerId: meId });
  };

  const handleAddBot = () => emitAction('addBot', { code: state.code, playerId: meId });
  const handleRemoveBot = () => emitAction('removeBot', { code: state.code, playerId: meId });

  const handleDraw = () => {
    if (!canAct || drawnCardId) return;
    setDrawAnimating(true);
    setTimeout(() => setDrawAnimating(false), 420);
    emitAction('drawCard', { code: state.code, playerId: meId });
  };
  const handlePass = () => emitAction('passTurn', { code: state.code, playerId: meId });
  const handleCallUno = () => emitAction('callUNO', { code: state.code, playerId: meId });
  const handleCatchUno = () => emitAction('catchUNO', { code: state.code, playerId: meId });
  const handleChallenge = () => emitAction('challengeWildDrawFour', { code: state.code, playerId: meId });
  const handleDeclineChallenge = () => emitAction('declineChallenge', { code: state.code, playerId: meId });

  const isPlayableClient = (card) => {
    if (!game) return false;
    if (!myTurn || isAdvancing || awaitingColor || pendingChallenge) return false;
    if (drawnCardId && card.id !== drawnCardId) return false;

    if (card.type === 'wild') return true;
    if (card.type === 'wild4') {
      const hasColor = (state.hand || []).some((c) => c.color === game.currentColor);
      return !hasColor;
    }

    const top = game.discardTop;
    if (!top) return false;
    if (card.color && card.color === game.currentColor) return true;
    if (card.type === 'number' && top.type === 'number' && card.value === top.value) return true;
    if (['skip', 'reverse', 'draw2'].includes(card.type) && card.type === top.type) return true;
    return false;
  };

  const handlePlayCard = (card) => {
    if (!canAct) return;
    if (!isPlayableClient(card)) return;
    setAnimatingCardId(card.id);
    setTimeout(() => setAnimatingCardId(null), 420);
    if (card.type === 'wild' || card.type === 'wild4') {
      setColorPicker({ open: true, cardId: card.id });
      return;
    }
    emitAction('playCard', { code: state.code, playerId: meId, cardId: card.id });
  };

  const chooseColor = (color) => {
    emitAction('playCard', {
      code: state.code,
      playerId: meId,
      cardId: colorPicker.cardId,
      chosenColor: color
    });
    setColorPicker({ open: false, cardId: null });
  };

  const handleCopy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      addToast('Invite code copied!');
    } catch (err) {
      addToast('Copy failed');
    }
  };

  const renderHome = () => {
    const storedCode = localStorage.getItem('uno_code');
    const storedPlayer = localStorage.getItem('uno_playerId');
    return (
      <div className="screen home">
        <div className="hero">
          <h1>UNO Online</h1>
          <p>Fast, friendly, and fully server-authoritative.</p>
        </div>
        <div className="panel">
          <label>Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
          />
          <div className="row">
            <button className="primary" onClick={handleCreate}>
              Create Lobby
            </button>
          </div>
          <div className="divider">or join</div>
          <input
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            placeholder="Invite code"
          />
          <div className="row">
            <button onClick={handleJoin}>Join Lobby</button>
          </div>
          {storedCode && storedPlayer && (
            <div className="row">
              <button className="ghost" onClick={handleReconnect}>
                Reconnect to {storedCode}
              </button>
            </div>
          )}
          {error && <p className="error">{error}</p>}
          {!connected && <p className="muted">Connecting to server...</p>}
        </div>
      </div>
    );
  };

  const renderLobby = () => {
    const players = state.players || [];
    const emptySeats = Math.max(0, 4 - players.length);
    return (
      <div className="screen lobby">
        <header>
          <div>
            <h2>Lobby {state.code}</h2>
            <p className="muted">Share this invite code with friends.</p>
          </div>
          <div className="lobby-actions">
            <div className="badge">{players.length}/4 Players</div>
            <button className="copy" onClick={() => handleCopy(state.code)}>
              Copy Code
            </button>
          </div>
        </header>
        <div className="seat-grid">
          {players.map((p) => (
            <div key={p.id} className={`seat-card ${p.isBot ? 'bot' : ''}`}>
              <div className="seat-name">{p.name}</div>
              <div className="seat-sub">
                {p.isHost ? 'Host' : p.isBot ? 'Bot' : p.connected ? 'Online' : 'Disconnected'}
              </div>
            </div>
          ))}
          {Array.from({ length: emptySeats }).map((_, idx) => (
            <div key={`empty-${idx}`} className="seat-card empty">
              Empty Seat
            </div>
          ))}
        </div>
        <div className="actions-row">
          {isHost && (
            <>
              <button className="primary" onClick={handleStart}>
                Start Game
              </button>
              <button onClick={handleAddBot}>Add Bot</button>
              <button onClick={handleRemoveBot}>Remove Bot</button>
            </>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    );
  };

  const renderFinished = () => {
    const winner = state.players.find((p) => p.id === game.winnerId);
    return (
      <div className="screen finished">
        <h2>Game Over</h2>
        <p className="winner">{winner ? `${winner.name} wins!` : 'Winner decided'}</p>
        {isHost && (
          <button className="primary" onClick={handleStart}>
            Play Again
          </button>
        )}
      </div>
    );
  };

  const renderGame = () => {
    const players = state.players || [];
    const currentPlayer = players[game.currentPlayerIndex];
    const directionArrow = game.direction === 1 ? '↻' : '↺';

    const showChallenge = pendingChallenge && pendingChallenge.challengerId === meId;
    const showCallUno = unoPending && unoPending.playerId === meId;
    const showCatchUno = unoPending && unoPending.playerId !== meId;

    const seatMap = getSeatMap(players, myIndex);

    return (
      <div className="screen game">
        <header className="game-topbar">
          <div className="lobby-code">
            <span>Lobby</span>
            <strong>{state.code}</strong>
            <button className="copy" onClick={() => handleCopy(state.code)}>
              Copy
            </button>
          </div>
          <div className={`turn-pill ${myTurn ? 'active' : ''}`}>
            {myTurn ? 'Your turn' : `${currentPlayer?.name || 'Player'}'s turn`}
          </div>
          <div className="direction-indicator">{directionArrow}</div>
        </header>

        <div className="table">
          <Seat
            position="north"
            player={seatMap.north}
            isActive={seatMap.north?.index === game.currentPlayerIndex}
            unoPendingId={unoPending?.playerId}
            penaltyPops={penaltyPops}
            seatShakes={seatShakes}
            cardRain={cardRain}
          />
          <Seat
            position="west"
            player={seatMap.west}
            isActive={seatMap.west?.index === game.currentPlayerIndex}
            unoPendingId={unoPending?.playerId}
            penaltyPops={penaltyPops}
            seatShakes={seatShakes}
            cardRain={cardRain}
          />
          <Seat
            position="east"
            player={seatMap.east}
            isActive={seatMap.east?.index === game.currentPlayerIndex}
            unoPendingId={unoPending?.playerId}
            penaltyPops={penaltyPops}
            seatShakes={seatShakes}
            cardRain={cardRain}
          />
          <Seat
            position="south"
            player={seatMap.south}
            isActive={seatMap.south?.index === game.currentPlayerIndex}
            unoPendingId={unoPending?.playerId}
            isYou
            penaltyPops={penaltyPops}
            seatShakes={seatShakes}
            cardRain={cardRain}
          />

          <div className={`center-area ${game.currentColor || 'none'}`}>
            <div className="pile-row">
              <div className="pile-stack discard-stack">
                <UnoCard card={game.discardTop} size="large" />
              </div>

              <button
                className={`pile-stack draw-stack ${drawAnimating ? 'drawing' : ''}`}
                onClick={handleDraw}
                disabled={!canAct || !!drawnCardId}
              >
                <CardBack className="stacked" />
                <CardBack className="stacked offset-1" />
                <CardBack className="stacked offset-2" />
                <span className="pile-label">Draw {game.drawDeckCount}</span>
              </button>
            </div>

            <div className="center-meta">
              <div className={`active-color ${game.currentColor}`}>
                <span className="dot" />
                {COLOR_LABELS[game.currentColor] || 'None'}
              </div>
              <div className="direction-chip">{directionArrow}</div>
              <div className="pile-counts">Discard {game.discardPileCount}</div>
            </div>
          </div>
        </div>

        <div className="hand-dock">
          <div className="hand">
            {(state.hand || []).map((card) => {
              const playable = isPlayableClient(card);
              const dim = myTurn && !playable;
              return (
                <UnoCard
                  key={card.id}
                  card={card}
                  playable={playable}
                  dim={dim}
                  animate={animatingCardId === card.id}
                  onClick={() => handlePlayCard(card)}
                />
              );
            })}
          </div>
          <div className="action-bar">
            <button className="action" onClick={handleDraw} disabled={!canAct || !!drawnCardId}>
              Draw
            </button>
            <button className="action" onClick={handlePass} disabled={!canAct || !drawnCardId}>
              Pass
            </button>
            {showCallUno && (
              <button className="action primary" onClick={handleCallUno}>
                UNO
              </button>
            )}
            {showCatchUno && (
              <button className="action warn" onClick={handleCatchUno}>
                Catch UNO
              </button>
            )}
            {showChallenge && (
              <>
                <button className="action warn" onClick={handleChallenge}>
                  Challenge
                </button>
                <button className="action" onClick={handleDeclineChallenge}>
                  No Challenge
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="app">
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              {t.message}
            </div>
          ))}
        </div>
      )}

      {state?.phase === 'lobby' && renderLobby()}
      {state?.phase === 'playing' && renderGame()}
      {state?.phase === 'finished' && renderFinished()}
      {!state && renderHome()}

      {colorPicker.open && (
        <div className="modal">
          <div className="modal-card">
            <h3>Choose a color</h3>
            <div className="color-grid">
              {COLORS.map((color) => (
                <button
                  key={color}
                  className={`color-choice ${color}`}
                  onClick={() => chooseColor(color)}
                >
                  {COLOR_LABELS[color]}
                </button>
              ))}
            </div>
            <button className="ghost" onClick={() => setColorPicker({ open: false, cardId: null })}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Seat({ position, player, isActive, unoPendingId, isYou, penaltyPops, seatShakes, cardRain }) {
  if (!player) return null;
  const showUno = unoPendingId === player.id;
  const pops = penaltyPops?.[player.id] || [];
  const shaking = seatShakes?.[player.id];
  const rain = cardRain?.[player.id] || [];
  return (
    <div className={`seat ${position} ${isActive ? 'active' : ''} ${isYou ? 'you' : ''} ${shaking ? 'shake' : ''}`}>
      <div className="seat-inner">
        <div className="seat-header">
          <span className="seat-name">{player.name}</span>
          {isYou && <span className="seat-you">You</span>}
        </div>
        {!isYou && (
          <OpponentHandBacks count={player.handCount} orientation={position} />
        )}
        {!isYou && <div className="count-badge">{player.handCount}</div>}
        {showUno && <div className="uno-badge">UNO!</div>}
        {isYou && isActive && <div className="turn-badge">Your turn</div>}
        {pops.map((pop, idx) => (
          <div key={pop.id} className={`penalty-pop ${pop.tone}`} style={{ '--pop-index': idx }}>
            +{pop.value}
          </div>
        ))}
        {rain.length > 0 && (
          <div className="card-rain">
            {rain.map((drop) => (
              <div
                key={drop.id}
                className="rain-card"
                style={{
                  '--rain-x': `${drop.x}%`,
                  '--rain-delay': `${drop.delay}ms`,
                  '--rain-duration': `${drop.duration}ms`
                }}
              >
                <CardBack className="rain-back" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OpponentHandBacks({ count, orientation }) {
  const visible = Math.min(count, 12);
  return (
    <div className={`opponent-backs ${orientation}`}>
      {Array.from({ length: visible }).map((_, idx) => (
        <CardBack key={idx} className="mini" />
      ))}
      {count > visible && <div className="extra-badge">+{count - visible}</div>}
    </div>
  );
}

function UnoCard({ card, size, playable, dim, animate, onClick }) {
  if (!card) {
    return (
      <div className={`uno-card empty ${size || ''}`}>
        <div className="card-face">?</div>
      </div>
    );
  }

  const classes = ['uno-card', size || '', playable ? 'playable' : '', dim ? 'dim' : '', animate ? 'played' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} onClick={onClick} role={onClick ? 'button' : undefined}>
      <CardFace card={card} />
    </div>
  );
}

function CardFace({ card }) {
  const baseColor = UNO_COLORS[card.color] || UNO_COLORS.black;
  const isWild = card.type === 'wild' || card.type === 'wild4';
  const corner = getCornerLabel(card);
  const center = getCenterLabel(card);

  return (
    <svg className="card-svg" viewBox="0 0 200 300" aria-hidden="true">
      <defs>
        <linearGradient id="cardGloss" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      <rect x="6" y="6" width="188" height="288" rx="22" fill={baseColor} stroke="#fff" strokeWidth="6" />
      <ellipse cx="100" cy="150" rx="85" ry="120" fill="rgba(255,255,255,0.18)" transform="rotate(-20 100 150)" />
      <ellipse cx="100" cy="150" rx="60" ry="95" fill="rgba(255,255,255,0.12)" transform="rotate(-20 100 150)" />
      <rect x="6" y="6" width="188" height="288" rx="22" fill="url(#cardGloss)" />

      {isWild && (
        <g>
          <circle cx="70" cy="120" r="18" fill={UNO_COLORS.red} />
          <circle cx="130" cy="120" r="18" fill={UNO_COLORS.yellow} />
          <circle cx="70" cy="180" r="18" fill={UNO_COLORS.green} />
          <circle cx="130" cy="180" r="18" fill={UNO_COLORS.blue} />
        </g>
      )}

      <text x="26" y="44" className="card-index">
        {corner}
      </text>
      <text x="174" y="258" className="card-index" transform="rotate(180 174 258)">
        {corner}
      </text>

      <g className="card-center">
        {card.type === 'skip' && (
          <g>
            <circle cx="100" cy="150" r="34" fill="none" stroke="#fff" strokeWidth="8" />
            <line x1="76" y1="174" x2="124" y2="126" stroke="#fff" strokeWidth="10" />
          </g>
        )}
        {card.type === 'reverse' && (
          <text x="100" y="166" className="card-text" textAnchor="middle">
            ↺↻
          </text>
        )}
        {card.type === 'draw2' && (
          <text x="100" y="170" className="card-text" textAnchor="middle">
            +2
          </text>
        )}
        {card.type === 'wild' && (
          <text x="100" y="170" className="card-text" textAnchor="middle">
            WILD
          </text>
        )}
        {card.type === 'wild4' && (
          <text x="100" y="170" className="card-text" textAnchor="middle">
            +4
          </text>
        )}
        {card.type === 'number' && (
          <text x="100" y="170" className="card-text" textAnchor="middle">
            {center}
          </text>
        )}
      </g>
    </svg>
  );
}

function CardBack({ className = '' }) {
  return (
    <div className={`card-back ${className}`}>
      <svg className="card-svg" viewBox="0 0 200 300" aria-hidden="true">
        <defs>
          <linearGradient id="backGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#ff5b5b" />
            <stop offset="100%" stopColor="#b60f2a" />
          </linearGradient>
        </defs>
        <rect x="6" y="6" width="188" height="288" rx="22" fill="url(#backGrad)" stroke="#fff" strokeWidth="6" />
        <ellipse cx="100" cy="150" rx="85" ry="120" fill="rgba(255,255,255,0.2)" transform="rotate(-20 100 150)" />
        <ellipse cx="100" cy="150" rx="60" ry="95" fill="rgba(255,255,255,0.15)" transform="rotate(-20 100 150)" />
        <text x="100" y="175" className="card-back-text" textAnchor="middle">
          UNO
        </text>
      </svg>
    </div>
  );
}

function getCornerLabel(card) {
  if (card.type === 'number') return String(card.value);
  if (card.type === 'skip') return '⦸';
  if (card.type === 'reverse') return '↺';
  if (card.type === 'draw2') return '+2';
  if (card.type === 'wild') return 'W';
  if (card.type === 'wild4') return '+4';
  return '';
}

function getCenterLabel(card) {
  if (card.type === 'number') return String(card.value);
  return '';
}

function getSeatMap(players, myIndex) {
  if (!players || players.length === 0 || myIndex < 0) {
    return { south: null, north: null, west: null, east: null };
  }
  const map = {
    south: { ...players[myIndex], index: myIndex }
  };
  const positions = ['west', 'north', 'east'];
  for (let offset = 1; offset < players.length; offset += 1) {
    const pos = positions[offset - 1] || 'east';
    const index = (myIndex + offset) % players.length;
    map[pos] = { ...players[index], index };
  }
  return {
    south: map.south,
    north: map.north || null,
    west: map.west || null,
    east: map.east || null
  };
}

function parsePenaltyToast(message, players) {
  if (!message) return null;
  const match = message.match(/^(.+?)(?: challenged and| forgot UNO and)? draws (\d+)/i);
  if (!match) return null;
  const value = Number(match[2]);
  if (!Number.isFinite(value) || value < 2) return null;
  const name = match[1].trim();
  const player = players.find((p) => p.name === name);
  if (!player) return null;
  return { playerId: player.id, value };
}

function pushPenaltyPop(playerId, value, setPenaltyPops, setSeatShakes) {
  const id = `${Date.now()}-${Math.random()}`;
  const tone = value >= 4 ? 'pop-red' : 'pop-yellow';
  setPenaltyPops((prev) => {
    const current = prev[playerId] || [];
    return { ...prev, [playerId]: [...current, { id, value, tone }] };
  });
  if (setSeatShakes) {
    setSeatShakes((prev) => ({ ...prev, [playerId]: id }));
  }
  setTimeout(() => {
    setPenaltyPops((prev) => {
      const current = prev[playerId] || [];
      const next = current.filter((pop) => pop.id !== id);
      if (next.length === 0) {
        const { [playerId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [playerId]: next };
    });
  }, 1400);

  if (setSeatShakes) {
    setTimeout(() => {
      setSeatShakes((prev) => {
        if (prev[playerId] !== id) return prev;
        const { [playerId]: _removed, ...rest } = prev;
        return rest;
      });
    }, 520);
  }
}

function spawnCardRain(playerId, value, setCardRain) {
  const count = Math.min(8, Math.max(3, value));
  const drops = Array.from({ length: count }).map(() => ({
    id: `${Date.now()}-${Math.random()}`,
    x: Math.floor(20 + Math.random() * 60),
    delay: Math.floor(Math.random() * 240),
    duration: Math.floor(900 + Math.random() * 400)
  }));

  setCardRain((prev) => {
    const current = prev[playerId] || [];
    return { ...prev, [playerId]: [...current, ...drops] };
  });

  setTimeout(() => {
    setCardRain((prev) => {
      const current = prev[playerId] || [];
      const next = current.filter((item) => !drops.some((drop) => drop.id === item.id));
      if (next.length === 0) {
        const { [playerId]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [playerId]: next };
    });
  }, 1600);
}

export default App;
