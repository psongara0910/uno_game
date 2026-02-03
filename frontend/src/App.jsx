import { useEffect, useMemo, useState } from 'react';
import { io } from 'socket.io-client';

const COLORS = ['red', 'yellow', 'green', 'blue'];
const COLOR_LABELS = {
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  blue: 'Blue'
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
    s.on('toast', (msg) => addToast(msg));
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

  const isHost = state?.hostId && state?.hostId === meId;

  const handleStart = () => {
    emitAction('startGame', { code: state.code, playerId: meId });
  };

  const handleAddBot = () => emitAction('addBot', { code: state.code, playerId: meId });
  const handleRemoveBot = () => emitAction('removeBot', { code: state.code, playerId: meId });

  const handleDraw = () => emitAction('drawCard', { code: state.code, playerId: meId });
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
          <div className="badge">{players.length}/4 Players</div>
        </header>
        <div className="seat-grid">
          {players.map((p) => (
            <div key={p.id} className={`seat ${p.isBot ? 'bot' : ''}`}>
              <div className="seat-name">{p.name}</div>
              <div className="seat-sub">
                {p.isHost ? 'Host' : p.isBot ? 'Bot' : p.connected ? 'Online' : 'Disconnected'}
              </div>
            </div>
          ))}
          {Array.from({ length: emptySeats }).map((_, idx) => (
            <div key={`empty-${idx}`} className="seat empty">
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
    const directionArrow = game.direction === 1 ? '→' : '←';

    const showChallenge = pendingChallenge && pendingChallenge.challengerId === meId;
    const showCallUno = unoPending && unoPending.playerId === meId;
    const showCatchUno = unoPending && unoPending.playerId !== meId;

    return (
      <div className="screen game">
        <header className="game-header">
          <div>
            <div className="badge">Lobby {state.code}</div>
            <div className="status">
              {myTurn ? 'Your turn' : `${currentPlayer?.name || 'Player'}'s turn`}
            </div>
          </div>
          <div className="direction">Direction {directionArrow}</div>
        </header>

        <div className="opponents">
          {players.map((p, idx) => (
            <div
              key={p.id}
              className={`opponent ${idx === game.currentPlayerIndex ? 'active' : ''}`}
            >
              <div className="opponent-name">{p.name}</div>
              <div className="opponent-count">{p.handCount} cards</div>
            </div>
          ))}
        </div>

        <div className="board">
          <div className="discard">
            <div className="label">Discard</div>
            <Card card={game.discardTop} large />
          </div>
          <div className="draw">
            <div className="label">Draw Pile</div>
            <button className="draw-button" onClick={handleDraw} disabled={!canAct || !!drawnCardId}>
              Draw ({game.drawDeckCount})
            </button>
            <div className="pill">Discard {game.discardPileCount}</div>
          </div>
          <div className="color-indicator">
            <div className={`color-dot ${game.currentColor}`} />
            <span>Active: {COLOR_LABELS[game.currentColor] || 'None'}</span>
          </div>
        </div>

        <div className="actions-row">
          <button onClick={handlePass} disabled={!canAct || !drawnCardId}>
            Pass
          </button>
          <button onClick={handleCallUno} disabled={!showCallUno}>
            UNO
          </button>
          <button onClick={handleCatchUno} disabled={!showCatchUno}>
            Catch UNO
          </button>
          {showChallenge && (
            <>
              <button className="warn" onClick={handleChallenge}>
                Challenge
              </button>
              <button onClick={handleDeclineChallenge}>No Challenge</button>
            </>
          )}
        </div>

        <div className="hand">
          {(state.hand || []).map((card) => (
            <Card
              key={card.id}
              card={card}
              playable={isPlayableClient(card)}
              onClick={() => handlePlayCard(card)}
            />
          ))}
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

function Card({ card, playable, onClick, large }) {
  if (!card) {
    return (
      <div className={`card empty ${large ? 'large' : ''}`}>
        <div className="card-face">?</div>
      </div>
    );
  }

  const label = getCardLabel(card);
  const classes = ['card', card.color || 'wild', large ? 'large' : '', playable ? 'playable' : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes} onClick={onClick} role={onClick ? 'button' : undefined}>
      <div className="card-face">
        <div className="card-value">{label}</div>
      </div>
    </div>
  );
}

function getCardLabel(card) {
  if (card.type === 'number') return card.value;
  if (card.type === 'skip') return 'Skip';
  if (card.type === 'reverse') return 'Reverse';
  if (card.type === 'draw2') return '+2';
  if (card.type === 'wild') return 'Wild';
  if (card.type === 'wild4') return '+4';
  return '';
}

export default App;
