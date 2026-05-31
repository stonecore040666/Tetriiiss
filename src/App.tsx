import { useEffect, useRef, useCallback, useReducer, useState, useMemo } from "react";
import React from "react";
import { audio } from "./audio";
import { getSocket, disconnectSocket } from "./socket";

// ─── Multiplayer types ────────────────────────────────────────────────────────
interface RoomListItem {
  id: string; name: string; hasPasskey: boolean;
  playerCount: number; maxPlayers: number;
  status: 'waiting' | 'countdown' | 'playing';
}
interface RoomPublic {
  id: string; name: string; ownerId: string;
  maxPlayers: number; hasPasskey: boolean;
  players: { id: string; name: string; alive: boolean; survivalTime: number }[];
  status: 'waiting' | 'countdown' | 'playing';
}

// ─── Settings ────────────────────────────────────────────────────────────────
type BtnId = 'hold' | 'rotate' | 'left' | 'down' | 'right' | 'drop' | 'retry';
interface ButtonPos { x: number; y: number; }
type ButtonOffsets = Record<BtnId, ButtonPos>;
const DEFAULT_BTN_OFFSETS: ButtonOffsets = {
  hold:{x:0,y:0}, rotate:{x:0,y:0}, left:{x:0,y:0},
  down:{x:0,y:0}, right:{x:0,y:0}, drop:{x:0,y:0}, retry:{x:0,y:0},
};

interface AppSettings {
  bgmVolume: number;
  sfxVolume: number;
  bgmMuted: boolean;
  sfxMuted: boolean;
  reduceEffects: boolean;
  keys: { left: string; right: string; rotate: string; softDrop: string; hardDrop: string; hold: string; };
  buttonOffsets: ButtonOffsets;
}
const DEFAULT_SETTINGS: AppSettings = {
  bgmVolume: 1, sfxVolume: 1, bgmMuted: false, sfxMuted: false, reduceEffects: false,
  keys: { left: 'ArrowLeft', right: 'ArrowRight', rotate: 'ArrowUp', softDrop: 'ArrowDown', hardDrop: ' ', hold: 'h' },
  buttonOffsets: DEFAULT_BTN_OFFSETS,
};
function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('lanc_settings');
    if (raw) {
      const p = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS, ...p,
        keys: { ...DEFAULT_SETTINGS.keys, ...(p.keys || {}) },
        buttonOffsets: { ...DEFAULT_BTN_OFFSETS, ...(p.buttonOffsets || {}) },
      };
    }
  } catch (_) {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings(s: AppSettings): void {
  try { localStorage.setItem('lanc_settings', JSON.stringify(s)); } catch (_) {}
}
function displayKey(key: string): string {
  const m: Record<string, string> = { 'ArrowLeft':'←','ArrowRight':'→','ArrowUp':'↑','ArrowDown':'↓',' ':'SPACE','Escape':'ESC','Enter':'ENTER','Shift':'SHIFT','Control':'CTRL','Alt':'ALT','Tab':'TAB','Backspace':'BKSP','Delete':'DEL' };
  return m[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

const COLS = 10;
const ROWS = 20;

const TETROMINOES = {
  I: { shape: [[1, 1, 1, 1]], color: "#00f0f0", glow: "rgba(0,240,240,0.7)" },
  O: { shape: [[1, 1], [1, 1]], color: "#f0f000", glow: "rgba(240,240,0,0.7)" },
  T: { shape: [[0, 1, 0], [1, 1, 1]], color: "#a000f0", glow: "rgba(160,0,240,0.7)" },
  S: { shape: [[0, 1, 1], [1, 1, 0]], color: "#00f000", glow: "rgba(0,240,0,0.7)" },
  Z: { shape: [[1, 1, 0], [0, 1, 1]], color: "#f00000", glow: "rgba(240,0,0,0.7)" },
  J: { shape: [[1, 0, 0], [1, 1, 1]], color: "#0000f0", glow: "rgba(0,0,240,0.7)" },
  L: { shape: [[0, 0, 1], [1, 1, 1]], color: "#f0a000", glow: "rgba(240,160,0,0.7)" },
};

type TetrominoKey = keyof typeof TETROMINOES;
const TETROMINO_KEYS = Object.keys(TETROMINOES) as TetrominoKey[];

function randomTetromino(): TetrominoKey {
  return TETROMINO_KEYS[Math.floor(Math.random() * TETROMINO_KEYS.length)];
}

type Board = (string | 0)[][];

function createBoard(): Board {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(0));
}

interface Piece {
  type: TetrominoKey;
  shape: number[][];
  x: number;
  y: number;
}

function rotate(shape: number[][]): number[][] {
  const rows = shape.length;
  const cols = shape[0].length;
  const rotated: number[][] = Array.from({ length: cols }, () => Array(rows).fill(0));
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      rotated[c][rows - 1 - r] = shape[r][c];
  return rotated;
}

function spawnPiece(type: TetrominoKey): Piece {
  const shape = TETROMINOES[type].shape.map((row) => [...row]);
  return { type, shape, x: Math.floor((COLS - shape[0].length) / 2), y: 0 };
}

function isValid(board: Board, piece: Piece): boolean {
  for (let r = 0; r < piece.shape.length; r++)
    for (let c = 0; c < piece.shape[r].length; c++) {
      if (!piece.shape[r][c]) continue;
      const ny = piece.y + r, nx = piece.x + c;
      if (ny < 0 || ny >= ROWS || nx < 0 || nx >= COLS) return false;
      if (board[ny][nx] !== 0) return false;
    }
  return true;
}

function placePiece(board: Board, piece: Piece): Board {
  const newBoard = board.map((row) => [...row]) as Board;
  const color = TETROMINOES[piece.type].color;
  for (let r = 0; r < piece.shape.length; r++)
    for (let c = 0; c < piece.shape[r].length; c++) {
      if (!piece.shape[r][c]) continue;
      const ny = piece.y + r, nx = piece.x + c;
      if (ny >= 0 && ny < ROWS && nx >= 0 && nx < COLS)
        newBoard[ny][nx] = color as string;
    }
  return newBoard;
}

function clearLines(board: Board): { board: Board; cleared: number } {
  const newBoard = board.filter((row) => row.some((cell) => cell === 0)) as Board;
  const cleared = ROWS - newBoard.length;
  const empty = Array.from({ length: cleared }, () => Array(COLS).fill(0)) as Board;
  return { board: [...empty, ...newBoard], cleared };
}

function calcScore(lines: number, level: number): number {
  const base = [0, 40, 100, 300, 1200];
  return (base[lines] || 0) * (level + 1);
}

function nesDropMs(level: number): number {
  // NES-inspired but softened: level 8+ is gentler (min ~100ms instead of 17ms)
  const frames = [48, 43, 38, 33, 28, 22, 17, 13, 10, 8, 7, 6, 6, 6, 5, 5, 5, 5, 5, 5];
  return Math.round((frames[Math.min(level, frames.length - 1)] / 60) * 1000);
}

function ghostPosition(board: Board, piece: Piece): Piece {
  let ghost = { ...piece };
  while (isValid(board, { ...ghost, y: ghost.y + 1 }))
    ghost = { ...ghost, y: ghost.y + 1 };
  return ghost;
}

interface GameState {
  board: Board;
  current: Piece;
  next: TetrominoKey;
  hold: TetrominoKey | null;
  canHold: boolean;
  score: number;
  lines: number;
  level: number;
  gameOver: boolean;
  startTime: number;
  elapsed: number;
}

type Action =
  | { type: "MOVE_LEFT" } | { type: "MOVE_RIGHT" } | { type: "MOVE_DOWN" }
  | { type: "ROTATE" } | { type: "HARD_DROP" } | { type: "TICK" } | { type: "HOLD" }
  | { type: "TICK_TIME"; elapsed: number } | { type: "RESTART" };

function initState(): GameState {
  return {
    board: createBoard(),
    current: spawnPiece(randomTetromino()),
    next: randomTetromino(),
    hold: null, canHold: true,
    score: 0, lines: 0, level: 0,
    gameOver: false,
    startTime: Date.now(), elapsed: 0,
  };
}

function landPiece(state: GameState): GameState {
  const newBoard = placePiece(state.board, state.current);
  const { board: clearedBoard, cleared } = clearLines(newBoard);
  const newLines = state.lines + cleared;
  const newLevel = Math.floor(newLines / 10);
  const newScore = state.score + calcScore(cleared, state.level);
  const nextPiece = spawnPiece(state.next);
  const nextNext = randomTetromino();
  const topRowBlocked = clearedBoard[0].some(cell => cell !== 0);
  if (topRowBlocked || !isValid(clearedBoard, nextPiece))
    return { ...state, board: clearedBoard, score: newScore, lines: newLines, level: newLevel, gameOver: true, canHold: true };
  return { ...state, board: clearedBoard, current: nextPiece, next: nextNext, score: newScore, lines: newLines, level: newLevel, canHold: true };
}

function gameReducer(state: GameState, action: Action): GameState {
  if (state.gameOver && action.type !== "RESTART") return state;

  switch (action.type) {
    case "MOVE_LEFT": { const m = { ...state.current, x: state.current.x - 1 }; return isValid(state.board, m) ? { ...state, current: m } : state; }
    case "MOVE_RIGHT": { const m = { ...state.current, x: state.current.x + 1 }; return isValid(state.board, m) ? { ...state, current: m } : state; }
    case "MOVE_DOWN": {
      const m = { ...state.current, y: state.current.y + 1 };
      return isValid(state.board, m) ? { ...state, current: m } : landPiece(state);
    }
    case "ROTATE": {
      const rotated = { ...state.current, shape: rotate(state.current.shape) };
      if (isValid(state.board, rotated)) return { ...state, current: rotated };
      for (const kick of [-1, 1, -2, 2]) {
        const kicked = { ...rotated, x: rotated.x + kick };
        if (isValid(state.board, kicked)) return { ...state, current: kicked };
      }
      return state;
    }
    case "HARD_DROP": {
      const ghost = ghostPosition(state.board, state.current);
      const hardDropScore = (ghost.y - state.current.y) * 2;
      return landPiece({ ...state, current: { ...state.current, y: ghost.y }, score: state.score + hardDropScore });
    }
    case "HOLD": {
      if (!state.canHold) return state;
      const heldType = state.hold;
      const newHold = state.current.type;
      const newCurrent = heldType ? spawnPiece(heldType) : spawnPiece(state.next);
      const newNext = heldType ? state.next : randomTetromino();
      if (!isValid(state.board, newCurrent)) return state;
      return { ...state, current: newCurrent, hold: newHold, next: newNext, canHold: false };
    }
    case "TICK": {
      const m = { ...state.current, y: state.current.y + 1 };
      return isValid(state.board, m) ? { ...state, current: m } : landPiece(state);
    }
    case "TICK_TIME": return { ...state, elapsed: action.elapsed };
    case "RESTART": return initState();
    default: return state;
  }
}

function formatTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function getGlow(color: string): string {
  for (const k of TETROMINO_KEYS)
    if (TETROMINOES[k].color === color) return TETROMINOES[k].glow;
  return "rgba(255,255,255,0.5)";
}

// Board cells: no shadowBlur (too expensive at 200 cells/frame)
function drawCell(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, _glow: string, size: number) {
  const pad = 1;
  const px = x * size + pad, py = y * size + pad, pw = size - pad * 2, ph = size - pad * 2;
  ctx.fillStyle = color;
  ctx.fillRect(px, py, pw, ph);
  // Subtle inner highlight (top-left edge)
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fillRect(px, py, pw, 2);
  ctx.fillRect(px, py, 2, ph);
  // Dark inner shadow (bottom-right edge)
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(px, py + ph - 2, pw, 2);
  ctx.fillRect(px + pw - 2, py, 2, ph);
}

// Active piece: with glow (only ~4 cells per frame)
function drawCellGlow(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, glow: string, size: number) {
  ctx.save();
  const pad = 1;
  const px = x * size + pad, py = y * size + pad, pw = size - pad * 2, ph = size - pad * 2;
  ctx.shadowBlur = 16;
  ctx.shadowColor = glow;
  ctx.fillStyle = color;
  ctx.fillRect(px, py, pw, ph);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.fillRect(px, py, pw, 2);
  ctx.fillRect(px, py, 2, ph);
  ctx.restore();
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(Math.min(window.innerWidth, window.innerHeight) < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return isMobile;
}

function useCellSize() {
  const [cellSize, setCellSize] = useState(32);
  useEffect(() => {
    const calc = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const isMobile = Math.min(w, h) < 640;
      if (isMobile) {
        const isLandscape = w > h;
        const ctrlH  = isLandscape ? 0 : 220;
        const availH = isLandscape ? h : h - ctrlH - 24 - 48;
        // Account for left HOLD panel (~104px) + right panels (~104px) + gaps/padding (~32px)
        const sideW = isLandscape ? w * 0.45 : 240;
        const availW = Math.max(0, w - sideW);
        const maxH = Math.floor(availH / ROWS);
        const maxW = Math.floor(availW / COLS);
        setCellSize(Math.max(13, Math.min(maxH, maxW, isLandscape ? 28 : 24)));
      } else {
        const maxH = Math.floor((h - 40) / ROWS);
        const maxW = Math.floor((w * 0.55) / COLS);
        setCellSize(Math.max(24, Math.min(maxH, maxW, 38)));
      }
    };
    calc();
    window.addEventListener("resize", calc);
    return () => window.removeEventListener("resize", calc);
  }, []);
  return cellSize;
}

function LoadingScreen({ onDone }: { onDone: () => void }) {
  const [phase, setPhase] = useState(0);
  const [progress, setProgress] = useState(0);
  const [fadeOut, setFadeOut] = useState(false);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    timers.push(setTimeout(() => setPhase(1), 150));
    timers.push(setTimeout(() => setPhase(2), 400));
    timers.push(setTimeout(() => setPhase(3), 600));
    timers.push(setTimeout(() => setPhase(4), 1800));
    timers.push(setTimeout(() => setFadeOut(true), 2100));
    timers.push(setTimeout(() => onDone(), 2500));

    let p = 0;
    let startMs: number | null = null;
    const dur = 1200;
    let rafId: number;
    const animateBar = (now: number) => {
      if (startMs === null) startMs = now;
      p = Math.min(100, ((now - startMs) / dur) * 100);
      setProgress(p);
      if (p < 100) rafId = requestAnimationFrame(animateBar);
    };
    const barTimer = setTimeout(() => { rafId = requestAnimationFrame(animateBar); }, 600);
    timers.push(barTimer);

    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(rafId);
    };
  }, [onDone]);

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#000812",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      opacity: fadeOut ? 0 : 1,
      transition: "opacity 0.45s ease",
      overflow: "hidden",
      userSelect: "none",
    }}>
      <style>{`
        @keyframes lancScan {
          0% { transform: translateY(0); }
          100% { transform: translateY(100vh); }
        }
        @keyframes lancGlitch {
          0%,100% { clip-path: none; transform: translateX(0); }
          8%  { clip-path: inset(20% 0 60% 0); transform: translateX(-4px); }
          16% { clip-path: inset(60% 0 10% 0); transform: translateX(4px); }
          24% { clip-path: none; transform: translateX(-2px); }
          32% { transform: translateX(0); }
        }
        @keyframes lancPulse {
          0%,100% { opacity: 0.5; }
          50% { opacity: 1; }
        }
        @keyframes lancReady {
          0%,100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
      `}</style>

      {/* Scanline */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: "linear-gradient(transparent, rgba(0,240,240,0.35), transparent)", animation: "lancScan 4s linear infinite", pointerEvents: "none", willChange: "transform" }} />

      {/* Main content */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0, opacity: phase >= 1 ? 1 : 0, transform: phase >= 1 ? "translateY(0)" : "translateY(28px)", transition: "opacity 0.6s ease, transform 0.6s ease" }}>

        {/* LANC */}
        <div style={{
          fontSize: "clamp(60px, 14vw, 108px)",
          fontFamily: '"Orbitron", monospace',
          fontWeight: 900,
          color: "#00f0f0",
          letterSpacing: "0.18em",
          textShadow: "0 0 30px rgba(0,240,240,0.9), 0 0 60px rgba(0,240,240,0.5), 0 0 100px rgba(0,240,240,0.25)",
          animation: phase === 1 ? "lancGlitch 0.6s ease-out" : "none",
          lineHeight: 1.1,
        }}>LANC</div>

        {/* PROJECT */}
        <div style={{
          fontSize: "clamp(12px, 2.5vw, 18px)",
          fontFamily: '"Orbitron", monospace',
          fontWeight: 500,
          color: "rgba(0,240,240,0.55)",
          letterSpacing: "0.65em",
          opacity: phase >= 2 ? 1 : 0,
          transform: phase >= 2 ? "translateY(0)" : "translateY(10px)",
          transition: "opacity 0.5s ease, transform 0.5s ease",
          paddingLeft: "0.65em",
          marginTop: 2,
        }}>PROJECT</div>

        {/* Separator */}
        <div style={{
          width: phase >= 2 ? "clamp(200px, 36vw, 340px)" : "0px",
          height: "1px",
          background: "linear-gradient(90deg, transparent, rgba(0,240,240,0.5) 30%, rgba(0,240,240,0.5) 70%, transparent)",
          transition: "width 0.7s ease",
          margin: "28px 0 24px",
        }} />

        {/* Loading area */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 12,
          width: "clamp(200px, 36vw, 340px)",
          opacity: phase >= 3 ? 1 : 0,
          transition: "opacity 0.4s ease",
        }}>
          {/* Bar track */}
          <div style={{ width: "100%", height: 3, background: "rgba(0,240,240,0.12)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%",
              width: `${progress}%`,
              background: "linear-gradient(90deg, #006080, #00f0f0)",
              boxShadow: "0 0 10px rgba(0,240,240,0.9)",
              borderRadius: 2,
            }} />
          </div>

          {/* Status text */}
          <div style={{
            fontSize: 11,
            fontFamily: '"Orbitron", monospace',
            fontWeight: 600,
            letterSpacing: "0.4em",
            paddingLeft: "0.4em",
            color: phase >= 4 ? "#00f0f0" : "rgba(0,240,240,0.4)",
            animation: phase >= 4 ? "lancReady 0.4s ease infinite" : (phase >= 3 ? "lancPulse 1.2s ease infinite" : "none"),
            transition: "color 0.3s",
          }}>
            {phase >= 4 ? "READY" : "LOADING..."}
          </div>
        </div>
      </div>

      {/* Corner decorations */}
      {([
        { top: 16, left: 16,  borderTop: "2px solid", borderLeft:  "2px solid" },
        { top: 16, right: 16, borderTop: "2px solid", borderRight: "2px solid" },
        { bottom: 16, left: 16,  borderBottom: "2px solid", borderLeft:  "2px solid" },
        { bottom: 16, right: 16, borderBottom: "2px solid", borderRight: "2px solid" },
      ] as React.CSSProperties[]).map((pos, i) => (
        <div key={i} style={{ position: "absolute", width: 24, height: 24, borderColor: "rgba(0,240,240,0.35)", opacity: phase >= 2 ? 1 : 0, transition: `opacity 0.4s ease ${0.1 * i}s`, ...pos }} />
      ))}
    </div>
  );
}

function ControlsOverlay({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const noop = () => {};
  const sc = 0.72;

  const pcControls = [
    { key: "← →", action: "Move left / right" },
    { key: "↑", action: "Rotate" },
    { key: "↓", action: "Soft drop" },
    { key: "SPACE", action: "Hard drop" },
    { key: "H", action: "Hold piece" },
    { key: "R", action: "Reset game" },
  ];

  const sectionTitle: React.CSSProperties = {
    fontFamily: '"Orbitron", monospace', fontWeight: 700,
    fontSize: "clamp(8px, 1.2vw, 11px)", letterSpacing: "0.4em",
    color: "rgba(0,240,240,0.45)", marginBottom: 10,
  };
  const rowStyle: React.CSSProperties = {
    display: "flex", alignItems: "center",
    gap: 14, padding: "5px 0",
    borderBottom: "1px solid rgba(0,240,240,0.07)",
  };
  const keyStyle: React.CSSProperties = {
    fontFamily: '"Orbitron", monospace', fontWeight: 700,
    fontSize: "clamp(9px, 1.4vw, 12px)", letterSpacing: "0.2em",
    color: "#00f0f0", textShadow: "0 0 8px rgba(0,240,240,0.6)",
    background: "rgba(0,240,240,0.07)", border: "1px solid rgba(0,240,240,0.25)",
    borderRadius: 4, padding: "3px 8px", whiteSpace: "nowrap" as const,
    minWidth: 64, textAlign: "center" as const,
  };
  const actionStyle: React.CSSProperties = {
    fontFamily: '"Orbitron", monospace', fontWeight: 400,
    fontSize: "clamp(8px, 1.2vw, 11px)", letterSpacing: "0.18em",
    color: "rgba(255,255,255,0.7)", flex: 1,
  };

  // Scaled button wrapper — preserves layout space at scaled size
  const SB = ({ w, h, children }: { w: number; h: number; children: React.ReactNode }) => (
    <div style={{ width: w * sc, height: h * sc, flexShrink: 0, position: "relative" }}>
      <div style={{ transform: `scale(${sc})`, transformOrigin: "top left", position: "absolute", top: 0, left: 0 }}>
        {children}
      </div>
    </div>
  );

  const mobileRows: { btn: React.ReactNode; action: string }[] = [
    {
      btn: (
        <SB w={136} h={62}>
          <HoldBtn onPress={noop} canHold={true} />
        </SB>
      ),
      action: "Hold piece",
    },
    {
      btn: (
        <SB w={136} h={62}>
          <TouchBtn onPress={noop} label="ROTATE" color="#a000f0" wide />
        </SB>
      ),
      action: "Rotate piece",
    },
    {
      btn: (
        <div style={{ display: "flex", gap: 4 }}>
          <SB w={64} h={64}><TouchBtn onPress={noop} label="◀" color="#00aaff" size={64} /></SB>
          <SB w={64} h={64}><TouchBtn onPress={noop} label="↓" color="#00f060" size={64} /></SB>
          <SB w={64} h={64}><TouchBtn onPress={noop} label="▶" color="#00aaff" size={64} /></SB>
        </div>
      ),
      action: "Move left / Soft drop / Move right",
    },
    {
      btn: (
        <SB w={136} h={62}>
          <TouchBtn onPress={noop} label="DROP" color="#f0a000" wide />
        </SB>
      ),
      action: "Hard drop",
    },
    {
      btn: (
        <SB w={136} h={62}>
          <TouchBtn onPress={noop} label="RETRY" color="#f04040" wide />
        </SB>
      ),
      action: "Reset game",
    },
  ];

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 10000,
        background: "rgba(0,2,10,0.88)",
        display: "flex", alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: "linear-gradient(160deg, #000c1e 0%, #000508 100%)",
          border: "1px solid rgba(0,240,240,0.25)",
          borderRadius: 10,
          boxShadow: "0 0 40px rgba(0,240,240,0.12), inset 0 0 40px rgba(0,0,0,0.4)",
          padding: "clamp(20px, 4vw, 36px) clamp(22px, 5vw, 44px)",
          width: "clamp(320px, 88vw, 640px)",
          maxHeight: "90vh",
          overflowY: "auto",
          position: "relative",
        }}
      >
        {/* Corner accents */}
        {([
          { top: 10, left: 10, borderTop: "1.5px solid", borderLeft: "1.5px solid" },
          { top: 10, right: 10, borderTop: "1.5px solid", borderRight: "1.5px solid" },
          { bottom: 10, left: 10, borderBottom: "1.5px solid", borderLeft: "1.5px solid" },
          { bottom: 10, right: 10, borderBottom: "1.5px solid", borderRight: "1.5px solid" },
        ] as React.CSSProperties[]).map((pos, i) => (
          <div key={i} style={{ position: "absolute", width: 18, height: 18, borderColor: "rgba(0,240,240,0.35)", ...pos }} />
        ))}

        {/* Title */}
        <div style={{
          fontFamily: '"Orbitron", monospace', fontWeight: 900,
          fontSize: "clamp(13px, 2vw, 18px)", letterSpacing: "0.45em",
          color: "#00f0f0", textShadow: "0 0 18px rgba(0,240,240,0.7)",
          marginBottom: 6, textAlign: "center",
        }}>CONTROLS</div>
        <div style={{ width: "100%", height: 1, background: "linear-gradient(90deg, transparent, rgba(0,240,240,0.4), transparent)", marginBottom: 24 }} />

        {/* Two-column layout */}
        <div style={{ display: "flex", gap: "clamp(20px, 4vw, 48px)", flexWrap: "wrap" }}>

          {/* PC — keyboard */}
          <div style={{ flex: "1 1 180px" }}>
            <div style={sectionTitle}>⌨ KEYBOARD</div>
            {pcControls.map(({ key, action }) => (
              <div key={key} style={rowStyle}>
                <span style={keyStyle}>{key}</span>
                <span style={actionStyle}>{action}</span>
              </div>
            ))}
          </div>

          {/* Mobile — actual game buttons */}
          <div style={{ flex: "1 1 220px" }}>
            <div style={sectionTitle}>📱 TOUCH</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {mobileRows.map(({ btn, action }, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 14,
                  padding: "4px 0",
                  borderBottom: "1px solid rgba(0,240,240,0.07)",
                }}>
                  {btn}
                  <span style={actionStyle}>{action}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Close button */}
        <button
          onClick={onClose}
          style={{
            display: "block", margin: "24px auto 0",
            padding: "8px 28px",
            background: "transparent",
            color: "rgba(0,240,240,0.6)",
            border: "1px solid rgba(0,240,240,0.25)",
            borderRadius: 6,
            fontFamily: '"Orbitron", monospace', fontWeight: 700,
            fontSize: "clamp(9px, 1.3vw, 11px)", letterSpacing: "0.35em",
            cursor: "pointer", outline: "none",
            transition: "color 0.15s, border-color 0.15s",
          }}
          onMouseEnter={e => { e.currentTarget.style.color = "#00f0f0"; e.currentTarget.style.borderColor = "rgba(0,240,240,0.6)"; }}
          onMouseLeave={e => { e.currentTarget.style.color = "rgba(0,240,240,0.6)"; e.currentTarget.style.borderColor = "rgba(0,240,240,0.25)"; }}
        >✕ CLOSE</button>
      </div>
    </div>
  );
}

// ─── Settings sub-components (top-level to avoid re-mount on parent render) ──

function SVolRow({ label, vol, muted, onVol, onMute }: {
  label: string; vol: number; muted: boolean;
  onVol: (v: number) => void; onMute: (v: boolean) => void;
}) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'7px 0', borderBottom:'1px solid rgba(0,240,240,0.07)' }}>
      <span style={{ fontFamily:'"Orbitron",monospace', fontSize:10, color:'rgba(255,255,255,0.65)', letterSpacing:'0.12em', minWidth:32 }}>{label}</span>
      <input type="range" min={0} max={1} step={0.02} value={muted ? 0 : vol} disabled={muted}
        onChange={e => onVol(parseFloat(e.target.value))}
        style={{ flex:1, accentColor:'#00f0f0', cursor:muted?'not-allowed':'pointer', opacity:muted?0.3:1, height:18 }} />
      <button onClick={() => onMute(!muted)} style={{
        padding:'3px 10px', background:muted?'rgba(240,60,60,0.15)':'rgba(0,240,240,0.08)',
        border:`1px solid ${muted?'rgba(240,60,60,0.45)':'rgba(0,240,240,0.3)'}`,
        borderRadius:4, color:muted?'#f05070':'#00d0c0',
        fontFamily:'"Orbitron",monospace', fontSize:8, letterSpacing:'0.18em',
        cursor:'pointer', outline:'none', whiteSpace:'nowrap' as const, transition:'all 0.15s',
      }}>{muted ? '✕ MUTE' : '♪ ON'}</button>
    </div>
  );
}

function STogRow({ label, desc, value, onChange }: {
  label: string; desc?: string; value: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, padding:'8px 0', borderBottom:'1px solid rgba(0,240,240,0.07)' }}>
      <div>
        <div style={{ fontFamily:'"Orbitron",monospace', fontSize:10, color:'rgba(255,255,255,0.7)', letterSpacing:'0.12em' }}>{label}</div>
        {desc && <div style={{ fontFamily:'"Orbitron",monospace', fontSize:8, color:'rgba(255,255,255,0.3)', letterSpacing:'0.08em', marginTop:2 }}>{desc}</div>}
      </div>
      <button onClick={() => onChange(!value)} style={{
        padding:'5px 16px', borderRadius:4,
        background:value?'rgba(0,240,240,0.15)':'rgba(255,255,255,0.04)',
        border:`1px solid ${value?'rgba(0,240,240,0.55)':'rgba(255,255,255,0.12)'}`,
        color:value?'#00f0f0':'rgba(255,255,255,0.3)',
        fontFamily:'"Orbitron",monospace', fontSize:9, fontWeight:700, letterSpacing:'0.2em',
        cursor:'pointer', outline:'none', transition:'all 0.15s', flexShrink:0,
      }}>{value ? 'ON' : 'OFF'}</button>
    </div>
  );
}

function SKeyRow({ label, keyStr, active, onActivate }: {
  label: string; keyStr: string; active: boolean; onActivate: () => void;
}) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 0', borderBottom:'1px solid rgba(0,240,240,0.07)' }}>
      <span style={{ fontFamily:'"Orbitron",monospace', fontSize:9, color:'rgba(255,255,255,0.55)', letterSpacing:'0.12em', flex:1 }}>{label}</span>
      <button onClick={onActivate} style={{
        padding:'4px 0', width:88, textAlign:'center' as const,
        background:active?'rgba(0,240,240,0.2)':'rgba(0,240,240,0.07)',
        border:`1px solid ${active?'#00f0f0':'rgba(0,240,240,0.3)'}`,
        borderRadius:4, color:active?'#00f0f0':'#00d0c0',
        fontFamily:'"Orbitron",monospace', fontSize:11, fontWeight:700, letterSpacing:'0.1em',
        cursor:'pointer', outline:'none',
        boxShadow:active?'0 0 8px rgba(0,240,240,0.4)':'none',
        animation:active?'sKeyPulse 0.9s ease-in-out infinite':'none',
      }}>{active ? '···' : displayKey(keyStr)}</button>
    </div>
  );
}

// ─── MobileLayoutEditor ───────────────────────────────────────────────────────

function MobileLayoutEditor({ initialOffsets, onSave, onCancel }: {
  initialOffsets: ButtonOffsets;
  onSave: (offsets: ButtonOffsets) => void;
  onCancel: () => void;
}) {
  const [offsets, setOffsets] = useState<ButtonOffsets>(() => ({ ...DEFAULT_BTN_OFFSETS, ...initialOffsets }));
  const [selected, setSelected] = useState<BtnId | null>(null);
  const [modeTab, setModeTab] = useState<'practice' | 'competitive'>('practice');
  const dragState = useRef<{ id: BtnId; startPX: number; startPY: number; startX: number; startY: number } | null>(null);
  const demoCanvasRef = useRef<HTMLCanvasElement>(null);
  const noop = useCallback(() => {}, []);

  const cs = useMemo(() => {
    const w = window.innerWidth, h = window.innerHeight;
    const availH = h - 220 - 24 - 48;
    const availW = Math.max(0, w - 240);
    return Math.max(13, Math.min(Math.floor(availH / ROWS), Math.floor(availW / COLS), 24));
  }, []);

  const canvasW = COLS * cs, canvasH = ROWS * cs;
  const nextW = cs * 4, nextH = cs * 4;

  useEffect(() => {
    const cv = demoCanvasRef.current; if (!cv) return;
    const ctx = cv.getContext('2d'); if (!ctx) return;
    ctx.fillStyle = '#000a18'; ctx.fillRect(0, 0, canvasW, canvasH);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        ctx.fillStyle = 'rgba(255,255,255,0.03)'; ctx.fillRect(c*cs+0.5, r*cs+0.5, cs-1, cs-1);
        ctx.strokeStyle = 'rgba(0,240,240,0.06)'; ctx.lineWidth = 0.5;
        ctx.strokeRect(c*cs+0.5, r*cs+0.5, cs-1, cs-1);
      }
    }
    const colors = ['#00f0f0','#f0f000','#a000f0','#00f000','#f00000','#0000f0','#f0a000'];
    [[0,0,0,1,1,1,0,1,1,0],[1,1,0,1,0,1,1,1,0,1],[1,1,1,0,1,1,0,1,1,1],[0,1,1,1,1,0,1,1,1,1],[1,0,1,1,1,1,1,0,1,1]].forEach((row, ri) => {
      row.forEach((filled, c) => {
        if (!filled) return;
        const color = colors[(ri * 3 + c) % colors.length];
        const r = ROWS - 5 + ri;
        ctx.fillStyle = color; ctx.fillRect(c*cs+1, r*cs+1, cs-2, cs-2);
        ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(c*cs+2, r*cs+2, cs-4, 2);
      });
    });
  }, [cs, canvasW, canvasH]);

  const getOff = (id: BtnId): ButtonPos => offsets[id] ?? { x: 0, y: 0 };

  const onBtnPtrDown = (id: BtnId, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSelected(id);
    const o = getOff(id);
    dragState.current = { id, startPX: e.clientX, startPY: e.clientY, startX: o.x, startY: o.y };
  };

  const onBtnPtrMove = (e: React.PointerEvent) => {
    if (!dragState.current) return;
    e.stopPropagation();
    const ds = dragState.current;
    const dx = e.clientX - ds.startPX;
    const dy = e.clientY - ds.startPY;
    setOffsets(prev => ({ ...prev, [ds.id]: { x: Math.round(ds.startX + dx), y: Math.round(ds.startY + dy) } }));
  };

  const onBtnPtrUp = () => { dragState.current = null; };

  const resetSelected = () => {
    if (!selected) return;
    setOffsets(prev => ({ ...prev, [selected]: { x: 0, y: 0 } }));
  };

  const btnWrapper = (id: BtnId, children: React.ReactNode) => {
    const off = getOff(id);
    const isSel = selected === id;
    return (
      <div
        key={id}
        style={{
          transform: `translate(${off.x}px, ${off.y}px)`,
          outline: isSel ? '2px solid rgba(0,240,240,0.9)' : '2px solid transparent',
          outlineOffset: 3,
          borderRadius: 5,
          cursor: 'grab',
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none' as React.CSSProperties['WebkitUserSelect'],
          position: 'relative',
          flexShrink: 0,
        }}
        onPointerDown={e => onBtnPtrDown(id, e)}
        onPointerMove={onBtnPtrMove}
        onPointerUp={onBtnPtrUp}
        onPointerCancel={onBtnPtrUp}
      >
        {children}
        {isSel && (
          <div style={{
            position: 'absolute', top: -20, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.88)', color: '#00f0f0', fontSize: 7,
            padding: '1px 5px', borderRadius: 3, whiteSpace: 'nowrap' as const,
            fontFamily: '"Orbitron",monospace', pointerEvents: 'none', zIndex: 10,
            border: '1px solid rgba(0,240,240,0.3)',
          }}>
            {off.x >= 0 ? `+${off.x}` : off.x},{off.y >= 0 ? `+${off.y}` : off.y}
          </div>
        )}
      </div>
    );
  };

  const hasAnyOffset = (Object.values(offsets) as ButtonPos[]).some(o => o.x !== 0 || o.y !== 0);

  return (
    <div style={{ position:'fixed', inset:0, zIndex:20000, background:'linear-gradient(180deg,#000812 0%,#000508 100%)', userSelect:'none', overflow:'hidden' }}
      onClick={() => setSelected(null)}>
      {/* Top bar */}
      <div style={{ position:'absolute', top:0, left:0, right:0, zIndex:10, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 10px', background:'rgba(0,4,12,0.96)', borderBottom:'1px solid rgba(0,240,240,0.18)', gap:6 }}>
        <div style={{ display:'flex', gap:4, flexShrink:0 }}>
          {(['practice','competitive'] as const).map(m => (
            <button key={m} onClick={e => { e.stopPropagation(); setModeTab(m); setSelected(null); }} style={{
              padding:'4px 9px', borderRadius:4,
              background: modeTab===m ? 'rgba(0,240,240,0.14)' : 'transparent',
              border: `1px solid ${modeTab===m ? 'rgba(0,240,240,0.6)' : 'rgba(255,255,255,0.15)'}`,
              color: modeTab===m ? '#00f0f0' : 'rgba(255,255,255,0.35)',
              fontFamily:'"Orbitron",monospace', fontSize:7, letterSpacing:'0.12em', cursor:'pointer', outline:'none',
            }}>{m === 'practice' ? '◈ PRACTICE' : '⚡ COMPETITIVE'}</button>
          ))}
        </div>
        <div style={{ display:'flex', gap:5, alignItems:'center' }}>
          {selected && (
            <button onClick={e => { e.stopPropagation(); resetSelected(); }} style={{ padding:'4px 9px', background:'transparent', border:'1px solid rgba(255,100,100,0.35)', borderRadius:4, color:'rgba(255,120,120,0.8)', fontFamily:'"Orbitron",monospace', fontSize:7, letterSpacing:'0.1em', cursor:'pointer', outline:'none', whiteSpace:'nowrap' as const }}>
              ↺ {selected.toUpperCase()}
            </button>
          )}
          {hasAnyOffset && (
            <button onClick={e => { e.stopPropagation(); setOffsets({ ...DEFAULT_BTN_OFFSETS }); setSelected(null); }} style={{ padding:'4px 9px', background:'transparent', border:'1px solid rgba(255,255,255,0.12)', borderRadius:4, color:'rgba(255,255,255,0.3)', fontFamily:'"Orbitron",monospace', fontSize:7, cursor:'pointer', outline:'none', whiteSpace:'nowrap' as const }}>
              RESET ALL
            </button>
          )}
          <button onClick={e => { e.stopPropagation(); onCancel(); }} style={{ padding:'4px 10px', background:'transparent', border:'1px solid rgba(255,255,255,0.18)', borderRadius:4, color:'rgba(255,255,255,0.45)', fontFamily:'"Orbitron",monospace', fontSize:7, letterSpacing:'0.15em', cursor:'pointer', outline:'none' }}>CANCEL</button>
          <button onClick={e => { e.stopPropagation(); onSave(offsets); }} style={{ padding:'4px 10px', background:'rgba(0,240,240,0.12)', border:'1px solid rgba(0,240,240,0.5)', borderRadius:4, color:'#00f0f0', fontFamily:'"Orbitron",monospace', fontSize:7, letterSpacing:'0.15em', cursor:'pointer', outline:'none' }}>SAVE</button>
        </div>
      </div>

      {/* Instruction */}
      <div style={{ position:'absolute', top:46, left:0, right:0, textAlign:'center', fontFamily:'"Orbitron",monospace', fontSize:7, color:'rgba(0,240,240,0.45)', letterSpacing:'0.22em', zIndex:5, pointerEvents:'none' }}>
        TAP TO SELECT · DRAG TO MOVE
      </div>

      {/* Game area */}
      <div style={{ display:'flex', flexDirection:'column', alignItems:'center', width:'100%', minHeight:'100dvh' }}>
        <div style={{ display:'flex', width:'100%', justifyContent:'center', alignItems:'flex-start', gap:8, padding:'58px 8px 4px' }}>
          <div style={{ flexShrink:0, borderLeft:'3px solid rgba(0,170,255,0.8)', borderTop:'1px solid rgba(0,170,255,0.2)', borderRight:'1px solid rgba(0,170,255,0.1)', borderBottom:'1px solid rgba(0,170,255,0.1)', borderRadius:'0 5px 5px 0', padding:'5px 6px', background:'linear-gradient(135deg,#010d18,#021828)' }}>
            <div style={{ color:'rgba(0,170,255,0.75)', fontSize:7, letterSpacing:'0.2em', marginBottom:3, fontFamily:'"Orbitron",monospace', fontWeight:500 }}>HOLD</div>
            <div style={{ width:nextW, height:nextH, background:'rgba(0,0,0,0.3)', borderRadius:2 }} />
          </div>
          <canvas ref={demoCanvasRef} width={canvasW} height={canvasH} style={{ border:'2px solid rgba(0,240,240,0.45)', boxShadow:'0 0 28px rgba(0,240,240,0.18)', flexShrink:0 }} />
          <div style={{ display:'flex', flexDirection:'column', gap:5, flexShrink:0 }}>
            {['SCORE','LVL','NEXT','TIME','LINES'].map(l => (
              <div key={l} style={{ borderLeft:'3px solid rgba(0,240,240,0.5)', borderTop:'1px solid rgba(0,240,240,0.1)', borderRight:'1px solid rgba(0,240,240,0.05)', borderBottom:'1px solid rgba(0,240,240,0.05)', borderRadius:'0 5px 5px 0', padding:'5px 8px', background:'linear-gradient(135deg,#060a16,#0d1228)', minWidth:52 }}>
                <div style={{ color:'rgba(0,240,240,0.55)', fontSize:7, letterSpacing:'0.2em', fontFamily:'"Orbitron",monospace', fontWeight:500 }}>{l}</div>
                <div style={{ color:'rgba(255,255,255,0.15)', fontSize:11, fontFamily:'"Orbitron",monospace' }}>—</div>
              </div>
            ))}
          </div>
        </div>

        {/* Touch buttons area */}
        <div
          style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:9, padding:'10px 16px 20px', width:'100%', background:'linear-gradient(180deg,transparent 0%,rgba(0,4,16,0.97) 18%)', borderTop:'1px solid rgba(0,200,255,0.07)', position:'relative', zIndex:5 }}
          onClick={e => { if (e.target === e.currentTarget) setSelected(null); }}
        >
          <div style={{ display:'flex', gap:10, justifyContent:'center', width:'100%' }}>
            {btnWrapper('hold', <HoldBtn onPress={noop} canHold />)}
            {btnWrapper('rotate', <TouchBtn onPress={noop} label="ROTATE" color="#a000f0" wide />)}
          </div>
          <div style={{ display:'flex', gap:10, justifyContent:'center', width:'100%' }}>
            {btnWrapper('left', <TouchBtn onPress={noop} label="◀" color="#00aaff" size={64} />)}
            {btnWrapper('down', <TouchBtn onPress={noop} label="↓" color="#00f060" size={64} />)}
            {btnWrapper('right', <TouchBtn onPress={noop} label="▶" color="#00aaff" size={64} />)}
          </div>
          <div style={{ display:'flex', gap:10, justifyContent:'center', width:'100%' }}>
            {btnWrapper('drop', <TouchBtn onPress={noop} label="DROP" color="#f0a000" wide />)}
            {modeTab === 'practice'
              ? btnWrapper('retry', <TouchBtn onPress={noop} label="RETRY" color="#f04040" wide />)
              : (
                <div style={{ width:136, height:62, flexShrink:0, border:'1px dashed rgba(255,255,255,0.1)', borderRadius:5, display:'flex', alignItems:'center', justifyContent:'center' }}>
                  <span style={{ fontFamily:'"Orbitron",monospace', fontSize:7, color:'rgba(255,255,255,0.2)', letterSpacing:'0.2em' }}>— NONE —</span>
                </div>
              )
            }
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SettingsOverlay ──────────────────────────────────────────────────────────

function SettingsOverlay({ settings, onSave, onClose, isMobile }: {
  settings: AppSettings; onSave: (s: AppSettings) => void; onClose: () => void; isMobile: boolean;
}) {
  const [local, setLocal] = useState<AppSettings>(() => ({ ...settings, keys: { ...settings.keys } }));
  const [rebinding, setRebinding] = useState<keyof AppSettings['keys'] | null>(null);
  const [showMobileEditor, setShowMobileEditor] = useState(false);

  useEffect(() => { audio.setBgmVolume(local.bgmVolume); }, [local.bgmVolume]);
  useEffect(() => { audio.setBgmMuted(local.bgmMuted); }, [local.bgmMuted]);
  useEffect(() => { audio.setSfxVolume(local.sfxVolume); }, [local.sfxVolume]);
  useEffect(() => { audio.setSfxMuted(local.sfxMuted); }, [local.sfxMuted]);

  useEffect(() => {
    if (!rebinding) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') { setRebinding(null); return; }
      setLocal(prev => ({ ...prev, keys: { ...prev.keys, [rebinding]: e.key } }));
      setRebinding(null);
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [rebinding]);

  const handleClose = () => {
    audio.setBgmVolume(settings.bgmVolume); audio.setBgmMuted(settings.bgmMuted);
    audio.setSfxVolume(settings.sfxVolume); audio.setSfxMuted(settings.sfxMuted);
    onClose();
  };

  const upKey = <K extends keyof AppSettings>(k: K, v: AppSettings[K]) =>
    setLocal(prev => ({ ...prev, [k]: v }));

  const secTitle: React.CSSProperties = { fontFamily:'"Orbitron",monospace', fontWeight:700, fontSize:'clamp(8px,1.2vw,11px)', letterSpacing:'0.4em', color:'rgba(0,240,240,0.45)', marginBottom:10 };
  const cornerStyle = [
    { top:10,left:10,borderTop:'1.5px solid',borderLeft:'1.5px solid' },
    { top:10,right:10,borderTop:'1.5px solid',borderRight:'1.5px solid' },
    { bottom:10,left:10,borderBottom:'1.5px solid',borderLeft:'1.5px solid' },
    { bottom:10,right:10,borderBottom:'1.5px solid',borderRight:'1.5px solid' },
  ] as React.CSSProperties[];

  if (showMobileEditor) return (
    <MobileLayoutEditor
      initialOffsets={local.buttonOffsets}
      onSave={offs => { setLocal(prev => ({ ...prev, buttonOffsets: offs })); setShowMobileEditor(false); }}
      onCancel={() => setShowMobileEditor(false)}
    />
  );

  return (
    <div onClick={handleClose} style={{ position:'fixed', inset:0, zIndex:10000, background:'rgba(0,2,10,0.88)', display:'flex', alignItems:'center', justifyContent:'center', backdropFilter:'blur(4px)' }}>
      <style>{`@keyframes sKeyPulse{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(0,240,240,0.4);}50%{opacity:0.65;box-shadow:0 0 0 5px rgba(0,240,240,0.08);}}`}</style>
      <div onClick={e => e.stopPropagation()} style={{ background:'linear-gradient(160deg,#000c1e 0%,#000508 100%)', border:'1px solid rgba(0,240,240,0.25)', borderRadius:10, boxShadow:'0 0 40px rgba(0,240,240,0.12),inset 0 0 40px rgba(0,0,0,0.4)', padding:'clamp(20px,4vw,32px) clamp(22px,5vw,40px)', width:'clamp(320px,90vw,640px)', maxHeight:'88vh', overflowY:'auto', position:'relative' }}>
        {cornerStyle.map((p,i) => <div key={i} style={{ position:'absolute', width:18, height:18, borderColor:'rgba(0,240,240,0.35)', ...p }} />)}

        <div style={{ fontFamily:'"Orbitron",monospace', fontWeight:900, fontSize:'clamp(13px,2vw,18px)', letterSpacing:'0.45em', color:'#00f0f0', textShadow:'0 0 18px rgba(0,240,240,0.7)', marginBottom:6, textAlign:'center' }}>SETTINGS</div>
        <div style={{ width:'100%', height:1, background:'linear-gradient(90deg,transparent,rgba(0,240,240,0.4),transparent)', marginBottom:22 }} />

        <div style={{ marginBottom:22 }}>
          <div style={secTitle}>♪ AUDIO</div>
          <SVolRow label="BGM" vol={local.bgmVolume} muted={local.bgmMuted}
            onVol={v => { upKey('bgmVolume', v); audio.setBgmVolume(v); }}
            onMute={v => { upKey('bgmMuted', v); audio.setBgmMuted(v); }} />
          <SVolRow label="SFX" vol={local.sfxVolume} muted={local.sfxMuted}
            onVol={v => { upKey('sfxVolume', v); audio.setSfxVolume(v); }}
            onMute={v => { upKey('sfxMuted', v); audio.setSfxMuted(v); }} />
        </div>

        <div style={{ marginBottom:22 }}>
          <div style={secTitle}>✦ VISUALS</div>
          <STogRow label="REDUCE EFFECTS" desc="Turns off particles, flashes and glow animations" value={local.reduceEffects} onChange={v => upKey('reduceEffects',v)} />
        </div>

        <div style={{ marginBottom:22 }}>
          <div style={secTitle}>⌨ KEY BINDINGS</div>
          {rebinding && <div style={{ marginBottom:10, padding:'6px 12px', background:'rgba(0,240,240,0.07)', border:'1px solid rgba(0,240,240,0.3)', borderRadius:5, fontFamily:'"Orbitron",monospace', fontSize:9, color:'#00f0f0', letterSpacing:'0.2em', textAlign:'center' }}>PRESS ANY KEY · ESC TO CANCEL</div>}
          {([
            ['MOVE LEFT','left'],['MOVE RIGHT','right'],['ROTATE','rotate'],
            ['SOFT DROP','softDrop'],['HARD DROP','hardDrop'],['HOLD','hold'],
          ] as [string, keyof AppSettings['keys']][]).map(([lbl, action]) => (
            <SKeyRow key={action} label={lbl} keyStr={local.keys[action]} active={rebinding===action}
              onActivate={() => setRebinding(rebinding===action ? null : action)} />
          ))}
        </div>

        {isMobile && (
          <div style={{ marginBottom:22 }}>
            <div style={secTitle}>📱 MOBILE LAYOUT</div>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'7px 0', borderBottom:'1px solid rgba(0,240,240,0.07)' }}>
              <div>
                <div style={{ fontFamily:'"Orbitron",monospace', fontSize:10, color:'rgba(255,255,255,0.7)', letterSpacing:'0.12em' }}>BUTTON POSITIONS</div>
                <div style={{ fontFamily:'"Orbitron",monospace', fontSize:8, color:'rgba(255,255,255,0.35)', letterSpacing:'0.08em', marginTop:2 }}>
                  {(Object.values(local.buttonOffsets) as ButtonPos[]).some(o => o.x !== 0 || o.y !== 0) ? 'CUSTOMIZED' : 'DEFAULT'}
                </div>
              </div>
              <button onClick={() => setShowMobileEditor(true)} style={{ padding:'7px 16px', background:'rgba(0,240,240,0.08)', border:'1px solid rgba(0,240,240,0.4)', borderRadius:5, color:'#00f0f0', fontFamily:'"Orbitron",monospace', fontSize:9, fontWeight:700, letterSpacing:'0.2em', cursor:'pointer', outline:'none' }}>ADJUST ✦</button>
            </div>
            {(Object.values(local.buttonOffsets) as ButtonPos[]).some(o => o.x !== 0 || o.y !== 0) && (
              <button onClick={() => upKey('buttonOffsets', DEFAULT_BTN_OFFSETS)} style={{ marginTop:6, padding:'4px 12px', background:'transparent', border:'1px solid rgba(255,255,255,0.12)', borderRadius:4, color:'rgba(255,255,255,0.35)', fontFamily:'"Orbitron",monospace', fontSize:8, letterSpacing:'0.18em', cursor:'pointer', outline:'none' }}>↺ RESET ALL TO DEFAULT</button>
            )}
          </div>
        )}

        <div style={{ display:'flex', gap:12, justifyContent:'center', marginTop:6 }}>
          <button onClick={handleClose} style={{ padding:'8px 22px', background:'transparent', color:'rgba(0,240,240,0.5)', border:'1px solid rgba(0,240,240,0.2)', borderRadius:6, fontFamily:'"Orbitron",monospace', fontWeight:700, fontSize:'clamp(9px,1.3vw,11px)', letterSpacing:'0.35em', cursor:'pointer', outline:'none', transition:'color 0.15s,border-color 0.15s' }}
            onMouseEnter={e=>{e.currentTarget.style.color='#00f0f0';e.currentTarget.style.borderColor='rgba(0,240,240,0.5)';}}
            onMouseLeave={e=>{e.currentTarget.style.color='rgba(0,240,240,0.5)';e.currentTarget.style.borderColor='rgba(0,240,240,0.2)';}}
          >✕ CANCEL</button>
          <button onClick={() => { onSave(local); onClose(); }} style={{ padding:'8px 22px', background:'rgba(0,240,240,0.12)', color:'#00f0f0', border:'1px solid rgba(0,240,240,0.5)', borderRadius:6, fontFamily:'"Orbitron",monospace', fontWeight:700, fontSize:'clamp(9px,1.3vw,11px)', letterSpacing:'0.35em', cursor:'pointer', outline:'none', transition:'background 0.15s' }}
            onMouseEnter={e=>{e.currentTarget.style.background='rgba(0,240,240,0.22)';}}
            onMouseLeave={e=>{e.currentTarget.style.background='rgba(0,240,240,0.12)';}}
          >✓ SAVE</button>
        </div>
      </div>
    </div>
  );
}

function HomeScreen({ onStart, onMultiplayer, onOpenSettings }: { onStart: () => void; onMultiplayer: () => void; onOpenSettings: () => void }) {
  const [visible, setVisible] = useState(false);
  const [showControls, setShowControls] = useState(false);
  const hiScore = useMemo(() => parseInt(localStorage.getItem("tetris_hi") || "0", 10), []);
  const [mouse, setMouse] = useState({ x: 0, y: 0 });

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 60);
    const onKey = (e: KeyboardEvent) => { if (e.key !== 'Escape' && !showControls) onStart(); };
    window.addEventListener("keydown", onKey);
    return () => { clearTimeout(t); window.removeEventListener("keydown", onKey); };
  }, [onStart, showControls]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      setMouse({
        x: (e.clientX / window.innerWidth  - 0.5),
        y: (e.clientY / window.innerHeight - 0.5),
      });
    };
    const onTouch = (e: TouchEvent) => {
      if (e.touches.length === 0) return;
      const t = e.touches[0];
      setMouse({
        x: (t.clientX / window.innerWidth  - 0.5),
        y: (t.clientY / window.innerHeight - 0.5),
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("touchmove", onTouch, { passive: true });
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("touchmove", onTouch);
    };
  }, []);

  const tetroShapes = useMemo(() => [
    { cells: [[0,0],[1,0],[0,1],[1,1]], color: "rgba(240,240,0,0.22)", stroke: "rgba(240,240,0,0.55)", x: "2%",  y: "58%", spd: 3.2, depth: 0.6 },
    { cells: [[0,0],[1,0],[2,0],[3,0]], color: "rgba(0,240,240,0.18)", stroke: "rgba(0,240,240,0.5)",  x: "76%", y: "18%", spd: 3.8, depth: 1.0 },
    { cells: [[0,1],[1,1],[1,0],[2,0]], color: "rgba(0,240,120,0.18)", stroke: "rgba(0,240,120,0.5)",  x: "78%", y: "70%", spd: 4.2, depth: 0.4 },
    { cells: [[0,0],[1,0],[2,0],[2,1]], color: "rgba(240,120,0,0.18)", stroke: "rgba(240,120,0,0.5)",  x: "58%", y: "6%",  spd: 3.6, depth: 0.8 },
    { cells: [[0,0],[1,0],[2,0],[1,1]], color: "rgba(200,0,240,0.16)", stroke: "rgba(200,0,240,0.45)", x: "4%",  y: "12%", spd: 4.5, depth: 0.5 },
    { cells: [[0,0],[0,1],[1,1],[1,2]], color: "rgba(240,0,80,0.15)",  stroke: "rgba(240,0,80,0.42)",  x: "88%", y: "44%", spd: 3.4, depth: 0.9 },
  ], []);
  const CS = 34;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9998,
        background: "linear-gradient(180deg, #000812 0%, #000508 100%)",
        display: "flex", flexDirection: "column", alignItems: "flex-start", justifyContent: "center",
        overflow: "hidden", userSelect: "none",
        opacity: visible ? 1 : 0, transition: "opacity 0.5s ease",
        paddingLeft: "clamp(16px, 3vw, 40px)",
      }}
    >
      <style>{`
        @keyframes homeScan {
          0% { transform: translateY(0); } 100% { transform: translateY(100vh); }
        }
        @keyframes homeFloat {
          0%,100% { transform: translateY(0px); } 50% { transform: translateY(-8px); }
        }
        @keyframes homeGlow {
          0%,100% { opacity: 1; }
          50%      { opacity: 0.75; }
        }
        @keyframes homeStartHover {
          0%,100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.7; transform: scale(1.02); }
        }
      `}</style>

      {/* Scanline */}
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "3px", background: "linear-gradient(transparent, rgba(0,240,240,0.3), transparent)", animation: "homeScan 5s linear infinite", pointerEvents: "none", willChange: "transform" }} />

      {/* Decorative tetromino shapes — outer div handles cursor parallax, inner div handles float */}
      {tetroShapes.map((s, si) => {
        const MAX = 36;
        const tx = mouse.x * MAX * s.depth;
        const ty = mouse.y * MAX * s.depth;
        return (
          <div key={si} style={{
            position: "absolute", left: s.x, top: s.y,
            transform: `translate(${tx}px, ${ty}px)`,
            transition: "transform 0.25s cubic-bezier(0.33,1,0.68,1)",
            pointerEvents: "none",
          }}>
            <div style={{ animation: `homeFloat ${s.spd}s ease-in-out infinite`, animationDelay: `${si * 0.3}s`, willChange: "transform" }}>
              <svg width={CS * 4 + 4} height={CS * 4 + 4}>
                {s.cells.map(([cx, cy], ci) => (
                  <rect key={ci} x={cx * CS + 2} y={cy * CS + 2} width={CS - 4} height={CS - 4} rx={3} fill={s.color} stroke={s.stroke} strokeWidth={1.5} />
                ))}
              </svg>
            </div>
          </div>
        );
      })}

      {/* Top label */}
      <div style={{ position: "absolute", top: 28, left: "clamp(16px, 3vw, 40px)", fontSize: 11, fontFamily: '"Orbitron", monospace', fontWeight: 600, letterSpacing: "0.5em", color: "rgba(0,240,240,0.3)", paddingLeft: "0.5em" }}>LANC PROJECT</div>

      {/* Main title — left aligned */}
      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 0 }}>
        <div style={{
          fontSize: "clamp(32px, 6vw, 56px)",
          fontFamily: '"Orbitron", monospace',
          fontWeight: 900,
          color: "#00f0f0",
          letterSpacing: "0.12em",
          textShadow: "0 0 28px rgba(0,240,240,0.8), 0 0 56px rgba(0,240,240,0.35)",
          animation: "homeGlow 2.5s ease-in-out infinite",
          lineHeight: 1,
          willChange: "opacity",
        }}>TETRIS</div>

        {/* Separator */}
        <div style={{ width: "clamp(120px, 20vw, 220px)", height: "1px", background: "linear-gradient(90deg, rgba(0,240,240,0.5), rgba(0,240,240,0.2), transparent)", margin: "12px 0 16px" }} />

        {/* Hi Score */}
        {hiScore > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 9, fontFamily: '"Orbitron", monospace', fontWeight: 600, letterSpacing: "0.35em", color: "rgba(0,240,240,0.35)", marginBottom: 3 }}>HI-SCORE</div>
            <div style={{ fontSize: "clamp(14px, 2vw, 20px)", fontFamily: '"Orbitron", monospace', fontWeight: 700, color: "#00f0f0", textShadow: "0 0 14px rgba(0,240,240,0.6)" }}>{hiScore.toLocaleString()}</div>
          </div>
        )}

        {/* START button — white */}
        <button
          onClick={onStart}
          style={{
            marginTop: hiScore > 0 ? 0 : 6,
            marginLeft: -10,
            padding: "10px 32px",
            background: "transparent",
            color: "#ffffff",
            border: "1.5px solid transparent",
            borderRadius: 6,
            fontFamily: '"Orbitron", monospace',
            fontWeight: 900,
            fontSize: "clamp(13px, 2vw, 17px)",
            letterSpacing: "0.35em",
            cursor: "pointer",
            animation: "homeStartHover 2s ease-in-out infinite",
            transition: "transform 0.1s",
            outline: "none",
          }}
          onMouseEnter={e => (e.currentTarget.style.transform = "scale(1.04)")}
          onMouseLeave={e => (e.currentTarget.style.transform = "scale(1)")}
        >
          ▶ START
        </button>

        {/* MULTIPLAYER button */}
        <button
          onClick={onMultiplayer}
          style={{
            marginTop: 4,
            marginLeft: -10,
            padding: "10px 32px",
            background: "transparent",
            color: "#ffffff",
            border: "1.5px solid transparent",
            borderRadius: 6,
            fontFamily: '"Orbitron", monospace',
            fontWeight: 700,
            fontSize: "clamp(11px, 1.6vw, 14px)",
            letterSpacing: "0.35em",
            cursor: "pointer",
            transition: "transform 0.1s",
            outline: "none",
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.04)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
        >
          ⬡ MULTIPLAYER
        </button>

        {/* SETTINGS button */}
        <button
          onClick={onOpenSettings}
          style={{
            marginTop: 4,
            marginLeft: -10,
            padding: "10px 32px",
            background: "transparent",
            color: "#ffffff",
            border: "1.5px solid transparent",
            borderRadius: 6,
            fontFamily: '"Orbitron", monospace',
            fontWeight: 700,
            fontSize: "clamp(11px, 1.6vw, 14px)",
            letterSpacing: "0.35em",
            cursor: "pointer",
            transition: "transform 0.1s",
            outline: "none",
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.04)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
        >
          ⚙ SETTINGS
        </button>

        {/* CONTROLS button */}
        <button
          onClick={() => setShowControls(true)}
          style={{
            marginTop: 4,
            marginLeft: -10,
            padding: "10px 32px",
            background: "transparent",
            color: "#ffffff",
            border: "1.5px solid transparent",
            borderRadius: 6,
            fontFamily: '"Orbitron", monospace',
            fontWeight: 700,
            fontSize: "clamp(11px, 1.6vw, 14px)",
            letterSpacing: "0.35em",
            cursor: "pointer",
            transition: "transform 0.1s",
            outline: "none",
          }}
          onMouseEnter={e => { e.currentTarget.style.transform = "scale(1.04)"; }}
          onMouseLeave={e => { e.currentTarget.style.transform = "scale(1)"; }}
        >
          ☰ CONTROLS
        </button>
      </div>

      {showControls && <ControlsOverlay onClose={() => setShowControls(false)} />}

      {/* Credits — bottom-left */}
      <div style={{
        position: 'absolute', bottom: 22, left: 'clamp(16px, 3vw, 40px)',
        display: 'flex', flexDirection: 'column', gap: 5,
        pointerEvents: 'none',
      }}>
        <div style={{ fontSize: 8, fontFamily: '"Orbitron", monospace', color: 'rgba(0,240,240,0.22)', letterSpacing: '0.25em', textTransform: 'uppercase' }}>
          LANC Project
        </div>
        <div style={{ fontSize: 9, fontFamily: 'sans-serif', color: 'rgba(255,255,255,0.28)', letterSpacing: '0.04em' }}>
          Founder of this game by <span style={{ color: 'rgba(0,240,240,0.5)', fontWeight: 600 }}>やまこ！</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
          <span style={{ fontSize: 8, fontFamily: 'sans-serif', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.04em' }}>This game made by</span>
          {/* Replit logo mark */}
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ opacity: 0.55, flexShrink: 0 }}>
            <path d="M4 4h7.2A4.8 4.8 0 0 1 16 8.8v0A4.8 4.8 0 0 1 11.2 13.6H4V4Z" fill="#F26207"/>
            <path d="M4 13.6h7.2A4.8 4.8 0 0 1 16 18.4v0A4.8 4.8 0 0 1 11.2 23.2H4V13.6Z" fill="#F26207"/>
            <path d="M16 8.8h0A4.8 4.8 0 0 1 20.8 13.6v0A4.8 4.8 0 0 1 16 18.4h0V8.8Z" fill="#F26207"/>
          </svg>
          <span style={{ fontSize: 9, fontFamily: '"Orbitron", monospace', color: 'rgba(242,98,7,0.55)', letterSpacing: '0.12em', fontWeight: 600 }}>Replit</span>
        </div>
      </div>

      {/* Corner decorations */}
      {([
        { top: 16, left: 16,  borderTop: "2px solid", borderLeft:  "2px solid" },
        { top: 16, right: 16, borderTop: "2px solid", borderRight: "2px solid" },
        { bottom: 16, left: 16,  borderBottom: "2px solid", borderLeft:  "2px solid" },
        { bottom: 16, right: 16, borderBottom: "2px solid", borderRight: "2px solid" },
      ] as React.CSSProperties[]).map((pos, i) => (
        <div key={i} style={{ position: "absolute", width: 28, height: 28, borderColor: "rgba(0,240,240,0.3)", ...pos }} />
      ))}

    </div>
  );
}

type GameMode = 'practice' | 'competitive';

// Mini tetris board SVG for mode cards
function MiniBoardSVG({ mode }: { mode: GameMode }) {
  const cols = 7, rows = 13;
  const cs = 14; // cell size
  const W = cols * cs, H = rows * cs;

  // practice: colorful, relaxed ~35% fill
  const practiceBoard: (string | null)[][] = [
    [null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null],
    [null,null,null,null,null,null,null],
    [null,null,null,'#00f0f0','#00f0f0',null,null],
    [null,null,'#a000f0','#a000f0',null,null,null],
    [null,'#f0f000','#f0f000',null,'#00f000',null,null],
    ['#f0a000',null,'#a000f0','#a000f0','#00f000','#00f000',null],
    ['#f0a000','#f0a000',null,'#0000f0','#0000f0','#00f000',null],
    ['#f0f000','#f0f000','#f0a000','#0000f0',null,'#f00000',null],
    [null,'#00f0f0','#00f0f0','#00f0f0',null,'#f00000','#f00000'],
    ['#f00000','#f00000',null,'#00f000','#00f000','#00f000',null],
  ];

  // competitive: dense, ominous ~80% fill, red/orange dominant
  const competitiveBoard: (string | null)[][] = [
    [null,'#f00000','#f00000',null,'#f00000','#f00000',null],
    ['#f00000',null,'#f0a000','#f00000','#f00000',null,'#f00000'],
    ['#f0a000','#f00000','#f00000',null,'#f00000','#f00000','#f0a000'],
    ['#f00000','#f00000',null,'#f00000','#a000f0','#f00000','#f00000'],
    [null,'#f00000','#f00000','#f00000','#f00000',null,'#f00000'],
    ['#f00000','#f0a000','#f00000','#f00000',null,'#f00000','#f00000'],
    ['#f00000','#f00000','#f00000',null,'#f00000','#f00000','#f00000'],
    ['#f00000','#f00000',null,'#f00000','#f00000','#f0a000','#f00000'],
    ['#f0a000','#f00000','#f00000','#f00000',null,'#f00000','#f00000'],
    ['#f00000',null,'#f00000','#f00000','#f00000','#f00000',null],
    ['#f00000','#f00000','#f00000','#f00000','#f00000','#f00000','#f00000'],
    ['#f00000','#f00000','#f00000','#f00000','#f00000','#f00000','#f00000'],
    ['#f00000','#f00000','#f00000','#f00000','#f00000','#f00000','#f00000'],
  ];

  const board = mode === 'practice' ? practiceBoard : competitiveBoard;

  const svgFilter = mode === 'competitive'
    ? 'drop-shadow(0 0 2px #f00000aa)'
    : 'drop-shadow(0 0 2px #00f0f0aa)';

  return (
    <svg width={W} height={H} style={{ display: 'block', borderRadius: 4, overflow: 'hidden', filter: svgFilter }}>
      {/* background grid */}
      <rect width={W} height={H} fill="#000a18" />
      {Array.from({ length: rows }, (_, r) =>
        Array.from({ length: cols }, (_, c) => {
          const color = board[r][c];
          if (!color) return (
            <rect key={`${r}-${c}`} x={c * cs + 0.5} y={r * cs + 0.5} width={cs - 1} height={cs - 1}
              fill="rgba(255,255,255,0.03)" stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} />
          );
          return (
            <g key={`${r}-${c}`}>
              <rect x={c * cs + 1} y={r * cs + 1} width={cs - 2} height={cs - 2}
                fill={color} rx={1} />
              <rect x={c * cs + 2} y={r * cs + 2} width={cs - 4} height={2}
                fill="rgba(255,255,255,0.22)" rx={0.5} />
            </g>
          );
        })
      )}
    </svg>
  );
}

// ── Countdown → Game transition overlay ─────────────────────────────────────
function CountdownTransitionOverlay() {
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 10000, pointerEvents: 'none',
      overflow: 'hidden',
    }}>
      <style>{`
        @keyframes cdTransFlash {
          0%   { opacity: 0; }
          8%   { opacity: 1; }
          100% { opacity: 0; }
        }
        @keyframes cdTransScan {
          0%   { top: -8px; opacity: 1; }
          85%  { opacity: 1; }
          100% { top: 100%; opacity: 0; }
        }
        @keyframes cdTransScan2 {
          0%   { top: -8px; opacity: 0.45; }
          100% { top: 100%; opacity: 0; }
        }
      `}</style>
      {/* main green flash */}
      <div style={{
        position: 'absolute', inset: 0,
        background: '#00f060',
        animation: 'cdTransFlash 0.65s ease-out forwards',
      }} />
      {/* primary scan line */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 5,
        background: 'linear-gradient(transparent, #ffffff, transparent)',
        boxShadow: '0 0 28px 12px rgba(0,240,96,1), 0 0 70px 28px rgba(0,240,96,0.5)',
        animation: 'cdTransScan 0.28s linear forwards',
      }} />
      {/* trailing scan line */}
      <div style={{
        position: 'absolute', left: 0, right: 0, height: 2,
        background: 'rgba(0,240,96,0.6)',
        animation: 'cdTransScan2 0.36s 0.04s linear forwards',
      }} />
    </div>
  );
}

// ── Countdown Screen ─────────────────────────────────────────────────────────
function CountdownScreen({ onDone, isMulti }: { onDone: () => void; isMulti?: boolean }) {
  const [count, setCount] = useState<number | 'GO!'>(3);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const sequence: (number | 'GO!')[] = [3, 2, 1, 'GO!'];
    let idx = 0;

    const playSound = (val: number | 'GO!') => {
      if (val === 'GO!') {
        audio.playCountdownGo();
      } else {
        audio.playCountdownBeep(val as 3 | 2 | 1);
      }
    };

    const tick = () => {
      idx++;
      if (idx < sequence.length) {
        setCount(sequence[idx]);
        setFlash(true);
        playSound(sequence[idx]);
        setTimeout(() => setFlash(false), 80);
        setTimeout(tick, idx === sequence.length - 1 ? 700 : 1000);
      } else {
        setTimeout(onDone, 120);
      }
    };

    setFlash(true);
    playSound(3);
    setTimeout(() => setFlash(false), 80);
    setTimeout(tick, 1000);
  }, []);

  const isGo = count === 'GO!';
  const color = isGo ? '#00f060' : (isMulti ? '#2299ff' : '#f04040');

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: '#000812',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      userSelect: 'none',
    }}>
      <style>{`
        @keyframes cdPulse {
          0%   { transform: scale(1.18); opacity: 1; }
          100% { transform: scale(1);    opacity: 1; }
        }
        @keyframes cdScan {
          0%   { transform: translateY(-100vh); }
          100% { transform: translateY(100vh); }
        }
      `}</style>

      {/* scan line */}
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(transparent, ${color}55, transparent)`,
        animation: 'cdScan 2s linear infinite', pointerEvents: 'none' }} />

      {/* label */}
      <div style={{
        fontFamily: '"Orbitron", monospace', fontSize: 11, letterSpacing: '0.35em',
        color: isMulti ? 'rgba(34,153,255,0.85)' : 'rgba(240,64,64,0.7)',
        marginBottom: 24, textTransform: 'uppercase',
      }}>{isMulti ? 'ROOM MODE' : 'COMPETITIVE MODE'}</div>

      {/* number */}
      <div style={{
        fontFamily: '"Orbitron", monospace',
        fontSize: isGo ? 72 : 120,
        fontWeight: 900,
        color,
        textShadow: `0 0 40px ${color}, 0 0 80px ${color}88`,
        letterSpacing: isGo ? '0.12em' : '0',
        animation: 'cdPulse 0.25s ease-out',
        animationIterationCount: 1,
        background: flash ? `${color}22` : 'transparent',
        padding: '0 24px',
        borderRadius: 8,
        transition: 'background 0.08s',
        minWidth: 160,
        textAlign: 'center',
      }}>
        {count}
      </div>

      {/* decorative corners */}
      {[
        { top: 24, left: 24, borderTop: `2px solid ${color}88`, borderLeft: `2px solid ${color}88` },
        { top: 24, right: 24, borderTop: `2px solid ${color}88`, borderRight: `2px solid ${color}88` },
        { bottom: 24, left: 24, borderBottom: `2px solid ${color}88`, borderLeft: `2px solid ${color}88` },
        { bottom: 24, right: 24, borderBottom: `2px solid ${color}88`, borderRight: `2px solid ${color}88` },
      ].map((s, i) => (
        <div key={i} style={{ position: 'absolute', width: 40, height: 40, ...s }} />
      ))}
    </div>
  );
}

function ModeSelectScreen({ onSelect, onGoHome }: { onSelect: (mode: GameMode) => void; onGoHome: () => void }) {
  const [visible, setVisible] = useState(false);
  const [centered, setCentered] = useState<GameMode>('practice');
  const [starting, setStarting] = useState(false);
  const [startProg, setStartProg] = useState(0);
  const isMobile = useIsMobile();
  const isTouch = useMemo(() => !window.matchMedia('(hover: hover) and (pointer: fine)').matches, []);
  const touchStartX = useRef<number | null>(null);

  const modes: { id: GameMode; label: string; sub: string; tag: string; accent: string }[] = [
    { id: 'practice',    label: 'PRACTICE',    sub: 'Restart anytime',       tag: 'FREE PLAY',  accent: '#00f0f0' },
    { id: 'competitive', label: 'COMPETITIVE', sub: 'No restart · one shot',  tag: 'NO RETRY',   accent: '#f04040' },
  ];

  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 40);
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { onGoHome(); return; }
      if (starting) return;
      if (e.key === 'ArrowLeft')  setCentered('practice');
      if (e.key === 'ArrowRight') setCentered('competitive');
      if (e.key === 'Enter' || e.key === ' ') triggerStart(centered);
    }
    window.addEventListener('keydown', handleKey);
    return () => { clearTimeout(t); window.removeEventListener('keydown', handleKey); };
  }, [starting, centered]);

  function triggerStart(mode: GameMode) {
    if (starting) return;
    setStarting(true);
    setStartProg(0);
    let p = 0;
    const iv = setInterval(() => {
      p += 100 / 18;
      setStartProg(Math.min(100, p));
      if (p >= 100) {
        clearInterval(iv);
        setTimeout(() => onSelect(mode), 120);
      }
    }, 30);
  }

  function slide(dir: 'left' | 'right') {
    if (starting) return;
    setCentered(dir === 'left' ? 'practice' : 'competitive');
  }

  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }
  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 30) return; // too short, treat as tap
    slide(dx > 0 ? 'left' : 'right');
  }

  const centeredIdx = modes.findIndex(m => m.id === centered);
  const centeredMode = modes[centeredIdx];

  // Responsive card sizing
  const cardW = isMobile ? Math.min(200, window.innerWidth * 0.62) : 240;
  const cardOffset = isMobile ? Math.min(220, window.innerWidth * 0.68) : 300;

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      style={{
        position: 'fixed', inset: 0, zIndex: 9998,
        background: 'linear-gradient(180deg, #000812 0%, #000508 100%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        overflow: 'hidden', userSelect: 'none',
        opacity: visible ? 1 : 0, transition: 'opacity 0.35s ease',
      }}
    >
      <style>{`
        @keyframes msScan2 { 0% { transform: translateY(0); } 100% { transform: translateY(100vh); } }
        @keyframes msCardPulse {
          0%,100% { opacity: 1; transform: scale(1); }
          50%      { opacity: 0.85; transform: scale(1.015); }
        }
      `}</style>

      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: 'linear-gradient(transparent, rgba(0,240,240,0.25), transparent)', animation: 'msScan2 5s linear infinite', pointerEvents: 'none', willChange: 'transform' }} />

      {/* Header */}
      <div style={{ marginBottom: isMobile ? 20 : 32, textAlign: 'center' }}>
        <div style={{ fontSize: 10, fontFamily: '"Orbitron", monospace', fontWeight: 600, letterSpacing: '0.5em', color: 'rgba(0,240,240,0.35)', marginBottom: 8 }}>MODE SELECT</div>
        <div style={{ fontSize: isMobile ? 18 : 'clamp(18px, 3.5vw, 28px)', fontFamily: '"Orbitron", monospace', fontWeight: 900, color: '#00f0f0', letterSpacing: '0.08em', textShadow: '0 0 20px rgba(0,240,240,0.5)' }}>CHOOSE YOUR MODE</div>
      </div>

      {/* Carousel + side arrows */}
      <div style={{ position: 'relative', width: '100%', height: isMobile ? 290 : 340, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>

        {modes.map((m, idx) => {
          const isCentered = m.id === centered;
          const offset = (idx - centeredIdx) * cardOffset;
          return (
            <div
              key={m.id}
              onClick={() => {
                if (starting) return;
                if (!isCentered) { setCentered(m.id); return; }
                triggerStart(m.id);
              }}
              style={{
                position: 'absolute',
                transform: `translateX(${offset}px) scale(${isCentered ? 1 : 0.72})`,
                transition: 'transform 0.38s cubic-bezier(0.34,1.26,0.64,1), opacity 0.38s ease, filter 0.38s ease',
                opacity: isCentered ? 1 : 0.38,
                filter: isCentered ? 'none' : 'brightness(0.45)',
                cursor: 'pointer',
                zIndex: isCentered ? 2 : 1,
                width: cardW,
              }}
            >
              <div style={{
                background: 'linear-gradient(160deg, #060e20, #0a1830)',
                borderRadius: 14,
                overflow: 'hidden',
                animation: isCentered && !starting ? 'msCardPulse 2s ease-in-out infinite' : 'none',
                boxShadow: isCentered
                  ? `0 0 0 1.5px ${m.accent}, 0 12px 48px rgba(0,0,0,0.7), 0 0 32px ${m.accent}22`
                  : '0 0 0 1px rgba(255,255,255,0.08)',
                transition: 'box-shadow 0.38s ease',
              }}>
                {/* Preview image */}
                <div style={{ padding: isMobile ? '10px 10px 0' : '16px 16px 0', display: 'flex', justifyContent: 'center', background: 'rgba(0,0,0,0.3)' }}>
                  <MiniBoardSVG mode={m.id} />
                </div>

                {/* Tag badge */}
                <div style={{ margin: isMobile ? '8px 12px 0' : '12px 16px 0', display: 'inline-block', padding: '3px 8px', borderRadius: 4, background: `${m.accent}22`, border: `1px solid ${m.accent}66` }}>
                  <span style={{ fontSize: 8, fontFamily: '"Orbitron", monospace', fontWeight: 700, color: m.accent, letterSpacing: '0.3em' }}>{m.tag}</span>
                </div>

                {/* Label */}
                <div style={{ padding: isMobile ? '6px 12px 4px' : '8px 16px 6px' }}>
                  <div style={{ fontSize: isMobile ? 12 : 15, fontFamily: '"Orbitron", monospace', fontWeight: 900, color: '#fff', letterSpacing: '0.06em' }}>{m.label}</div>
                  <div style={{ marginTop: 3, fontSize: 8, fontFamily: '"Orbitron", monospace', color: 'rgba(255,255,255,0.38)', letterSpacing: '0.18em', lineHeight: 1.5 }}>{m.sub}</div>
                </div>

                {/* CTA */}
                <div style={{ padding: isMobile ? '8px 12px 10px' : '10px 16px 14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                  {isCentered ? (
                    <span style={{ fontSize: isMobile ? 9 : 10, fontFamily: '"Orbitron", monospace', fontWeight: 700, color: m.accent, letterSpacing: '0.35em', textShadow: `0 0 10px ${m.accent}` }}>
                      {starting ? 'LOADING...' : '▶ START'}
                    </span>
                  ) : (
                    <span style={{ fontSize: 8, fontFamily: '"Orbitron", monospace', color: 'rgba(255,255,255,0.2)', letterSpacing: '0.25em' }}>TAP TO SELECT</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Dot indicators (all devices) */}
      <div style={{ display: 'flex', gap: 8, marginTop: 36 }}>
        {modes.map(m => (
          <div key={m.id} style={{
            width: centered === m.id ? 20 : 6, height: 6,
            borderRadius: 3,
            background: centered === m.id ? centeredMode.accent : 'rgba(255,255,255,0.2)',
            transition: 'width 0.3s ease, background 0.3s ease',
          }} />
        ))}
      </div>

      {/* Full-screen loading overlay */}
      {starting && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: '#000812',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 24,
        }}>
          <div style={{ fontSize: 'clamp(14px, 3vw, 22px)', fontFamily: '"Orbitron", monospace', fontWeight: 700, color: centeredMode.accent, letterSpacing: '0.45em', textShadow: `0 0 20px ${centeredMode.accent}` }}>
            {centeredMode.label}
          </div>
          <div style={{ width: 'clamp(200px, 55vw, 360px)', height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${startProg}%`, background: `linear-gradient(90deg, ${centeredMode.accent}66, ${centeredMode.accent})`, borderRadius: 2, boxShadow: `0 0 12px ${centeredMode.accent}`, transition: 'width 0.03s linear' }} />
          </div>
          <div style={{ fontSize: 9, fontFamily: '"Orbitron", monospace', letterSpacing: '0.5em', color: `${centeredMode.accent}88` }}>LOADING...</div>
        </div>
      )}

      {/* Nav hint */}
      {!starting && !isTouch && (
        <div style={{ marginTop: 20, fontSize: 9, fontFamily: '"Orbitron", monospace', color: 'rgba(0,240,240,0.2)', letterSpacing: '0.28em' }}>← →  SWITCH  /  ENTER  START</div>
      )}
      {!starting && isTouch && (
        <div style={{ marginTop: 10, fontSize: 9, fontFamily: '"Orbitron", monospace', color: 'rgba(0,240,240,0.2)', letterSpacing: '0.25em' }}>SWIPE TO SWITCH  /  TAP CENTER TO START</div>
      )}

      {/* Back to home button */}
      <button
        onClick={onGoHome}
        style={{
          position: 'absolute', top: 14, left: 14,
          padding: '6px 14px', background: 'transparent',
          border: '1px solid rgba(0,240,240,0.35)', borderRadius: 5,
          color: 'rgba(0,240,240,0.7)', fontFamily: '"Orbitron", monospace',
          fontWeight: 700, fontSize: 9, letterSpacing: '0.25em',
          cursor: 'pointer', outline: 'none',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,240,240,0.08)'; e.currentTarget.style.color = '#00f0f0'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(0,240,240,0.7)'; }}
      >◀ HOME</button>

      {([
        { top: 16, left: 16, borderTop: '2px solid', borderLeft: '2px solid' },
        { top: 16, right: 16, borderTop: '2px solid', borderRight: '2px solid' },
        { bottom: 16, left: 16, borderBottom: '2px solid', borderLeft: '2px solid' },
        { bottom: 16, right: 16, borderBottom: '2px solid', borderRight: '2px solid' },
      ] as React.CSSProperties[]).map((pos, i) => (
        <div key={i} style={{ position: 'absolute', width: 24, height: 24, borderColor: 'rgba(0,240,240,0.2)', ...pos }} />
      ))}
    </div>
  );
}

function GameOverOverlay({
  score, lines, elapsed, gameMode, onRetry, onHome,
}: {
  score: number; lines: number; elapsed: number;
  gameMode: GameMode;
  onRetry: () => void; onHome: () => void;
}) {
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const ts = [
      setTimeout(() => setPhase(1), 60),
      setTimeout(() => setPhase(2), 300),
      setTimeout(() => setPhase(3), 700),
      setTimeout(() => setPhase(4), 1100),
    ];
    return () => ts.forEach(clearTimeout);
  }, []);

  const isComp = gameMode === 'competitive';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9000,
      background: 'rgba(0,1,6,0.97)',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      fontFamily: '"Orbitron", monospace',
      opacity: phase >= 1 ? 1 : 0,
      transition: 'opacity 0.35s ease',
      overflow: 'hidden',
    }}>
      <style>{`
        @keyframes goScan { 0%{transform:translateY(-100%)} 100%{transform:translateY(100vh)} }
        @keyframes goGlitchMain {
          0%,82%,100% { clip-path:none; transform:translate(0,0); }
          84%  { clip-path:inset(9% 0 76% 0);  transform:translate(-7px,0); color:#ff9090; }
          86%  { clip-path:inset(62% 0 12% 0); transform:translate(7px,0); }
          88%  { clip-path:inset(38% 0 44% 0); transform:translate(-4px,0); }
          90%  { clip-path:none; transform:translate(2px,0); }
          92%  { clip-path:inset(20% 0 65% 0); transform:translate(-2px,0); color:#ff4040; }
          94%  { clip-path:none; transform:translate(0,0); }
        }
        @keyframes goGlitchShadow {
          0%,82%,100% { clip-path:none; transform:translate(0,0); opacity:0; }
          84%  { clip-path:inset(9% 0 76% 0);  transform:translate(7px,0);  opacity:0.55; }
          86%  { clip-path:inset(62% 0 12% 0); transform:translate(-7px,0); opacity:0.4; }
          88%  { clip-path:none; opacity:0; }
          90%  { clip-path:inset(20% 0 65% 0); transform:translate(4px,0);  opacity:0.3; }
          94%  { clip-path:none; opacity:0; }
        }
        @keyframes goPulse {
          0%,100% { text-shadow:0 0 32px rgba(255,32,32,0.9),0 0 64px rgba(255,0,0,0.4); }
          50%     { text-shadow:0 0 56px rgba(255,32,32,1),0 0 110px rgba(255,0,0,0.65),0 0 180px rgba(255,0,0,0.2); }
        }
        @keyframes goSlideUp {
          from { opacity:0; transform:translateY(22px) scale(0.97); }
          to   { opacity:1; transform:translateY(0) scale(1); }
        }
        @keyframes goLineGrow {
          from { width:0; }
          to   { width:clamp(220px,52vw,420px); }
        }
        @keyframes goBtnBlink {
          0%,100% { opacity:1; } 50% { opacity:0.62; }
        }
        @keyframes goSubIn {
          from { opacity:0; letter-spacing:0.7em; }
          to   { opacity:1; letter-spacing:0.5em; }
        }
      `}</style>

      {/* Moving scanline */}
      <div style={{
        position:'absolute', top:0, left:0, right:0, height:'3px',
        background:'linear-gradient(transparent,rgba(255,50,50,0.45),transparent)',
        animation:'goScan 3.5s linear infinite', pointerEvents:'none', zIndex:1,
      }}/>

      {/* Static CRT scanlines */}
      <div style={{
        position:'absolute', inset:0, pointerEvents:'none', zIndex:1,
        backgroundImage:'repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.13) 2px,rgba(0,0,0,0.13) 3px)',
      }}/>

      {/* Corner brackets */}
      {([
        {top:18,left:18,borderTop:'2px solid',borderLeft:'2px solid'},
        {top:18,right:18,borderTop:'2px solid',borderRight:'2px solid'},
        {bottom:18,left:18,borderBottom:'2px solid',borderLeft:'2px solid'},
        {bottom:18,right:18,borderBottom:'2px solid',borderRight:'2px solid'},
      ] as React.CSSProperties[]).map((pos,i)=>(
        <div key={i} style={{position:'absolute',width:28,height:28,borderColor:'rgba(255,40,40,0.28)',opacity:phase>=2?1:0,transition:`opacity 0.4s ease ${i*0.08}s`,...pos}}/>
      ))}

      {/* Sub-label */}
      <div style={{
        fontSize:10, letterSpacing:'0.5em', paddingLeft:'0.5em',
        color:'rgba(255,60,60,0.5)', marginBottom:14, zIndex:2,
        opacity:phase>=2?1:0,
        animation:phase>=2?'goSubIn 0.5s ease both':'none',
      }}>{isComp ? 'FINAL RESULT' : 'GAME OVER'}</div>

      {/* GAME OVER glitch text */}
      <div style={{position:'relative', zIndex:2, marginBottom:6, opacity:phase>=2?1:0, transition:'opacity 0.4s ease'}}>
        <div style={{
          fontSize:'clamp(30px,7.5vw,62px)', fontWeight:900, color:'#ff2828',
          letterSpacing:'0.07em', lineHeight:1.1,
          animation:phase>=2?'goGlitchMain 3.2s ease-in-out infinite, goPulse 2s ease-in-out infinite':'none',
          position:'relative',
        }}>GAME OVER</div>
        {/* ghost layer for glitch */}
        <div style={{
          position:'absolute',inset:0,
          fontSize:'clamp(30px,7.5vw,62px)', fontWeight:900, color:'#ff7070',
          letterSpacing:'0.07em', lineHeight:1.1,
          animation:phase>=2?'goGlitchShadow 3.2s ease-in-out infinite':'none',
          pointerEvents:'none', userSelect:'none',
        }}>GAME OVER</div>
      </div>

      {/* Animated divider */}
      <div style={{
        height:'1px', marginBottom:32, zIndex:2,
        background:'linear-gradient(90deg,transparent,rgba(255,40,40,0.65) 30%,rgba(255,40,40,0.65) 70%,transparent)',
        width: phase>=2?'clamp(220px,52vw,420px)':'0px',
        transition:'width 0.7s ease',
        boxShadow:'0 0 12px rgba(255,0,0,0.4)',
      }}/>

      {/* Stat cards */}
      <div style={{display:'flex',gap:14,flexWrap:'wrap',justifyContent:'center',marginBottom:36,zIndex:2}}>
        {([
          {label:'SCORE', value:score.toLocaleString(), color:'#00f0f0', big:true,  delay:0},
          {label:'LINES', value:String(lines),          color:'#f0a000', big:false, delay:110},
          {label:'TIME',  value:formatTime(elapsed),    color:'#00f060', big:false, delay:220},
        ] as {label:string;value:string;color:string;big:boolean;delay:number}[]).map(({label,value,color,big,delay})=>(
          <div key={label} style={{
            display:'flex',flexDirection:'column',alignItems:'center',
            padding: big?'18px 26px':'14px 20px',
            background:'linear-gradient(155deg,#06101e,#0c1a30)',
            border:`1.5px solid ${color}44`, borderRadius:12,
            boxShadow:`0 0 28px ${color}1a, inset 0 0 20px rgba(0,0,0,0.45)`,
            minWidth: big?155:110,
            opacity: phase>=3?1:0,
            animation: phase>=3?`goSlideUp 0.5s cubic-bezier(0.22,1,0.36,1) ${delay}ms both`:'none',
          }}>
            <div style={{fontSize:8,letterSpacing:'0.42em',color:`${color}88`,marginBottom:7}}>{label}</div>
            <div style={{
              fontSize:big?'clamp(24px,4.2vw,36px)':'clamp(17px,2.8vw,24px)',
              fontWeight:900, color, lineHeight:1,
              textShadow:`0 0 16px ${color}aa, 0 0 32px ${color}44`,
            }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Buttons */}
      <div style={{display:'flex',gap:12,zIndex:2,opacity:phase>=4?1:0,transition:'opacity 0.4s ease'}}>
        {gameMode !== 'competitive' && (
          <button onClick={onRetry} style={{
            padding:'10px 26px', background:'rgba(255,36,36,0.07)',
            border:'1.5px solid rgba(255,50,50,0.55)', borderRadius:6,
            color:'#ff6060', fontFamily:'"Orbitron",monospace', fontWeight:700,
            fontSize:10, letterSpacing:'0.3em', cursor:'pointer', outline:'none',
            textShadow:'0 0 10px rgba(255,60,60,0.55)',
            transition:'background 0.15s',
          }}
            onMouseEnter={e=>(e.currentTarget.style.background='rgba(255,36,36,0.15)')}
            onMouseLeave={e=>(e.currentTarget.style.background='rgba(255,36,36,0.07)')}
          >↺ RETRY</button>
        )}
        <button onClick={onHome} style={{
          padding:'10px 26px', background:'transparent',
          border:'1.5px solid rgba(0,240,240,0.5)', borderRadius:6,
          color:'#00f0f0', fontFamily:'"Orbitron",monospace', fontWeight:700,
          fontSize:10, letterSpacing:'0.3em', cursor:'pointer', outline:'none',
          textShadow:'0 0 10px rgba(0,240,240,0.6)',
          animation:'goBtnBlink 2.2s ease-in-out infinite',
          transition:'background 0.15s',
        }}
          onMouseEnter={e=>(e.currentTarget.style.background='rgba(0,240,240,0.07)')}
          onMouseLeave={e=>(e.currentTarget.style.background='transparent')}
        >▶ HOME</button>
      </div>
    </div>
  );
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const nextCanvasRef = useRef<HTMLCanvasElement>(null);
  const holdCanvasRef = useRef<HTMLCanvasElement>(null);
  const [state, dispatch] = useReducer(gameReducer, undefined, initState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const isMobile = useIsMobile();
  const cellSize = useCellSize();
  const [screen, setScreen] = useState<'loading' | 'home' | 'modeselect' | 'countdown' | 'game' | 'multiplayer' | 'room_create' | 'room_wait' | 'multi_countdown' | 'multi_game'>('loading');
  const screenRef = useRef(screen);
  screenRef.current = screen;
  const [gameMode, setGameMode] = useState<GameMode>('practice');
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const settingsRef = useRef<AppSettings>(settings);
  settingsRef.current = settings;
  const [showSettings, setShowSettings] = useState(false);
  const reduceEffectsRef = useRef(settings.reduceEffects);
  useEffect(() => { reduceEffectsRef.current = settings.reduceEffects; }, [settings.reduceEffects]);
  const gameActiveRef = useRef(false);
  gameActiveRef.current = screen === 'game' || screen === 'multi_game';

  // ── Multiplayer state ──────────────────────────────────────────────────────
  const [multiRooms, setMultiRooms] = useState<RoomListItem[]>([]);
  const [currentRoom, setCurrentRoom] = useState<RoomPublic | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string>('');
  const myPlayerIdRef = useRef<string>('');
  useEffect(() => { myPlayerIdRef.current = myPlayerId; }, [myPlayerId]);
  const [otherBoards, setOtherBoards] = useState<Record<string, (string | 0)[][]>>({});
  const otherBoardsRef = useRef(otherBoards);
  otherBoardsRef.current = otherBoards;
  const multiSendRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [multiGameResult, setMultiGameResult] = useState<{ result: { id: string; name: string; time: number; score: number; lines: number }[] } | null>(null);
  const handleLoadingDone = useCallback(() => setScreen('home'), []);
  const handleGoModeSelect = useCallback(() => setScreen('modeselect'), []);
  const handleStartGame = useCallback((mode: GameMode) => {
    setGameMode(mode);
    if (mode === 'competitive') {
      setScreen('countdown');
    } else {
      setScreen('game');
      dispatch({ type: "RESTART" });
    }
  }, []);
  const [cdExiting, setCdExiting] = useState(false);
  const handleCountdownDone = useCallback(() => {
    setCdExiting(true);
    setTimeout(() => {
      setScreen('game');
      dispatch({ type: "RESTART" });
    }, 220);
    setTimeout(() => setCdExiting(false), 700);
  }, []);
  const cdTransitionOverlay = cdExiting ? <CountdownTransitionOverlay /> : null;
  const gameModeRef = useRef(gameMode);
  gameModeRef.current = gameMode;

  // Go-home full-screen loading overlay
  const [goHomeLoading, setGoHomeLoading] = useState(false);
  const [goHomeProg, setGoHomeProg] = useState(0);
  // ── Audio: BGM transitions + global click sound ───────────────────────────
  useEffect(() => {
    if (screen === 'game' || screen === 'multi_game') {
      audio.startGameBGM();
    } else if (screen === 'home' || screen === 'modeselect' || screen === 'multiplayer' || screen === 'room_create' || screen === 'room_wait') {
      audio.startMenuBGM();
    } else if (screen === 'countdown' || screen === 'multi_countdown') {
      audio.stopBGM();
    }
  }, [screen]);

  useEffect(() => {
    // Create AudioContext early and set up auto-unlock listeners
    // so BGM starts on the very first user gesture (click / key / touch)
    audio.setupAutoplay();
    audio.preload();
    // Apply persisted audio settings immediately on mount
    audio.setBgmVolume(settingsRef.current.bgmVolume);
    audio.setBgmMuted(settingsRef.current.bgmMuted);
    audio.setSfxVolume(settingsRef.current.sfxVolume);
    audio.setSfxMuted(settingsRef.current.sfxMuted);
  }, []);

  useEffect(() => {
    const handler = () => { audio.playClick(); };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);
  // ──────────────────────────────────────────────────────────────────────────

  const handleGoHome = useCallback(() => {
    if (goHomeLoading) return;
    const sc = screenRef.current;
    if (sc === 'multiplayer' || sc === 'room_create' || sc === 'room_wait' || sc === 'multi_countdown' || sc === 'multi_game') {
      try { getSocket().emit('leave_room'); disconnectSocket(); } catch (_) {}
      setCurrentRoom(null);
      setOtherBoards({});
      setScreen('home');
      return;
    }
    setGoHomeLoading(true);
    setGoHomeProg(0);
    let p = 0;
    const iv = setInterval(() => {
      p += 100 / 18;
      setGoHomeProg(Math.min(100, p));
      if (p >= 100) {
        clearInterval(iv);
        setTimeout(() => {
          setGoHomeLoading(false);
          setScreen('home');
        }, 120);
      }
    }, 30);
  }, [goHomeLoading]);

  interface Particle {
    x: number; y: number;
    vx: number; vy: number;
    color: string; glow: string;
    size: number; alpha: number; decay: number;
  }
  const particlesRef = useRef<Particle[]>([]);
  const gameOverTimeRef = useRef<number>(0);
  const placeFlashRef = useRef<{ cells: { x: number; y: number; color: string }[]; start: number } | null>(null);
  const rafRef = useRef<number>(0);
  const cellSizeRef = useRef(0);
  const isMobileRef = useRef(false);
  const prevStateRef = useRef(state);
  // React-state driven line-clear flash (guaranteed to trigger canvas redraw)
  const [lineClearAnim, setLineClearAnim] = useState<{
    rows: number[];
    cells: { r: number; c: number; color: string }[];
    startTime: number;
  } | null>(null);
  const lineClearAnimRef = useRef(lineClearAnim);
  lineClearAnimRef.current = lineClearAnim;

  const dropInterval = useCallback(() => nesDropMs(stateRef.current.level), []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    function tick() {
      if (!stateRef.current.gameOver && gameActiveRef.current) dispatch({ type: "TICK" });
      timer = setTimeout(tick, dropInterval());
    }
    timer = setTimeout(tick, dropInterval());
    return () => clearTimeout(timer);
  }, [dropInterval]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (!stateRef.current.gameOver && gameActiveRef.current)
        dispatch({ type: "TICK_TIME", elapsed: Date.now() - stateRef.current.startTime });
    }, 500);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    function matchKey(e: KeyboardEvent, stored: string) {
      return e.key === stored || (stored.length === 1 && e.key.toLowerCase() === stored.toLowerCase());
    }
    function handleKeyDown(e: KeyboardEvent) {
      const k = settingsRef.current.keys;
      const nav = [k.left, k.right, k.softDrop, k.rotate, k.hardDrop, 'ArrowLeft','ArrowRight','ArrowDown','ArrowUp',' '];
      if (nav.some(n => matchKey(e, n))) e.preventDefault();
    }
    function handleKeyUp(e: KeyboardEvent) {
      if (!gameActiveRef.current) return;
      const k = settingsRef.current.keys;
      const nav = [k.left, k.right, k.softDrop, k.rotate, k.hardDrop, 'ArrowLeft','ArrowRight','ArrowDown','ArrowUp',' '];
      if (nav.some(n => matchKey(e, n))) e.preventDefault();
      if      (matchKey(e, k.left))     { audio.playMove();     dispatch({ type: "MOVE_LEFT" }); }
      else if (matchKey(e, k.right))    { audio.playMove();     dispatch({ type: "MOVE_RIGHT" }); }
      else if (matchKey(e, k.softDrop)) { audio.playSoftDrop(); dispatch({ type: "MOVE_DOWN" }); }
      else if (matchKey(e, k.rotate))   { audio.playRotate();   dispatch({ type: "ROTATE" }); }
      else if (matchKey(e, k.hardDrop)) { audio.playHardDrop(); dispatch({ type: "HARD_DROP" }); }
      else if (matchKey(e, k.hold))     { audio.playHold();     dispatch({ type: "HOLD" }); }
      else if (e.key === 'r' || e.key === 'R') { if (gameModeRef.current !== 'competitive' && screenRef.current !== 'multi_game') dispatch({ type: "RESTART" }); }
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, []);

  // ── Multiplayer socket listeners ───────────────────────────────────────────
  useEffect(() => {
    const multiScreens = ['multiplayer', 'room_create', 'room_wait', 'multi_countdown', 'multi_game'];
    if (!multiScreens.includes(screen)) return;
    const sock = getSocket();
    const onRoomList = (rooms: RoomListItem[]) => setMultiRooms(rooms);
    const onRoomJoined = ({ room, myId }: { room: RoomPublic; myId: string }) => {
      setCurrentRoom(room);
      setMyPlayerId(myId);
      setScreen('room_wait');
    };
    const onRoomUpdated = (room: RoomPublic) => setCurrentRoom(room);
    const onJoinError = (msg: string) => alert('JOIN ERROR: ' + msg);
    const onGameCountdown = () => setScreen('multi_countdown');
    const onGameStart = () => {
      setScreen('multi_game');
      dispatch({ type: 'RESTART' });
      setOtherBoards({});
      setMultiGameResult(null);
    };
    const onPlayerBoard = ({ playerId, board }: { playerId: string; board: (string | 0)[][] }) => {
      setOtherBoards(prev => ({ ...prev, [playerId]: board }));
    };
    const onPlayerDied = ({ playerId }: { playerId: string }) => {
      setOtherBoards(prev => {
        const n = { ...prev };
        if (n[playerId]) {
          // keep board but could mark it
        }
        return n;
      });
    };
    const onGameEnded = (data: { result: { id: string; name: string; time: number; score: number; lines: number }[] }) => {
      setMultiGameResult(data);
      setOtherBoards({});
      setCurrentRoom(prev => prev ? { ...prev, status: 'waiting' } : null);
      const myId = myPlayerIdRef.current;
      const isWinner = data.result[0]?.id === myId;
      if (isWinner) {
        audio.playVictory();
      } else {
        audio.playGameOver();
      }
    };
    sock.on('room_list', onRoomList);
    sock.on('room_joined', onRoomJoined);
    sock.on('room_updated', onRoomUpdated);
    sock.on('join_error', onJoinError);
    sock.on('game_countdown', onGameCountdown);
    sock.on('game_start', onGameStart);
    sock.on('player_board', onPlayerBoard);
    sock.on('player_died', onPlayerDied);
    sock.on('game_ended', onGameEnded);
    return () => {
      sock.off('room_list', onRoomList);
      sock.off('room_joined', onRoomJoined);
      sock.off('room_updated', onRoomUpdated);
      sock.off('join_error', onJoinError);
      sock.off('game_countdown', onGameCountdown);
      sock.off('game_start', onGameStart);
      sock.off('player_board', onPlayerBoard);
      sock.off('player_died', onPlayerDied);
      sock.off('game_ended', onGameEnded);
    };
  }, [screen]);

  // ── Multiplayer board broadcast ────────────────────────────────────────────
  useEffect(() => {
    if (screen !== 'multi_game') {
      if (multiSendRef.current) { clearInterval(multiSendRef.current); multiSendRef.current = null; }
      return;
    }
    multiSendRef.current = setInterval(() => {
      const s = stateRef.current;
      if (!s.gameOver) {
        const displayBoard = s.current ? placePiece(s.board, s.current) : s.board;
        getSocket().emit('board_update', { board: displayBoard });
      }
    }, 300);
    return () => {
      if (multiSendRef.current) { clearInterval(multiSendRef.current); multiSendRef.current = null; }
    };
  }, [screen]);

  // ── Multiplayer: emit player_dead on game over ─────────────────────────────
  useEffect(() => {
    if (screen === 'multi_game' && state.gameOver) {
      try { getSocket().emit('player_dead', { time: stateRef.current.elapsed, score: stateRef.current.score, lines: stateRef.current.lines }); } catch (_) {}
    }
  }, [state.gameOver, screen]);

  useEffect(() => {
    const prev = prevStateRef.current;
    const now = Date.now();
    if (state.lines > prev.lines) {
      // placePiece+clearLines run atomically in the reducer so prev.board
      // never has full rows — reconstruct the intermediate board to find them.
      // Use ghostPosition to get the actual landing row (handles hard-drop where
      // prev.current.y is still the pre-drop position, not the landed position).
      const landedPiece = { ...prev.current, y: ghostPosition(prev.board, prev.current).y };
      const placed = placePiece(prev.board, landedPiece);
      const clearedRows: number[] = [];
      const clearedCells: { r: number; c: number; color: string }[] = [];
      for (let r = 0; r < ROWS; r++) {
        if (!placed[r].every(cell => cell !== 0)) continue;
        clearedRows.push(r);
        for (let c = 0; c < COLS; c++)
          clearedCells.push({ r, c, color: placed[r][c] as string });
      }
      if (clearedRows.length > 0) {
        setLineClearAnim({ rows: clearedRows, cells: clearedCells, startTime: now });
        audio.playLineClear(clearedRows.length);
        if (state.level > prev.level) audio.playLevelUp();
      }
    }
    if (!state.gameOver && prev.gameOver) {
      gameOverTimeRef.current = 0;
      particlesRef.current = [];
      placeFlashRef.current = null;
      setLineClearAnim(null);
    }
    if (state.gameOver && !prev.gameOver) {
      audio.stopBGM();
      audio.playGameOver();
      gameOverTimeRef.current = Date.now();
      const cs = cellSize || 32;
      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
          const color = state.board[r][c] as string;
          if (!color) continue;
          const glow = getGlow(color);
          const cx = c * cs + cs / 2;
          const cy = r * cs + cs / 2;
          const count = 4 + Math.floor(Math.random() * 3);
          for (let i = 0; i < count; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = 1 + Math.random() * 3;
            particlesRef.current.push({
              x: cx + (Math.random() - 0.5) * cs * 0.6,
              y: cy + (Math.random() - 0.5) * cs * 0.6,
              vx: Math.cos(angle) * speed * 0.5 + (Math.random() - 0.5) * 1.5,
              vy: Math.abs(Math.sin(angle)) * speed + (r / ROWS) * 1.5,
              color, glow,
              size: cs * (0.3 + Math.random() * 0.3),
              alpha: 1,
              decay: 0.006 + Math.random() * 0.006,
            });
          }
        }
      }
    }
    if (state.board !== prev.board && !state.gameOver) {
      const cells: { x: number; y: number; color: string }[] = [];
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) {
          const cur = state.board[r][c];
          if (cur !== 0 && prev.board[r][c] === 0)
            cells.push({ x: c, y: r, color: cur as string });
        }
      if (cells.length) placeFlashRef.current = { cells, start: now };
    }
    prevStateRef.current = state;
  }, [state, cellSize]);

  useEffect(() => {
    let active = true;
    function loop() {
      if (!active) return;
      if (!gameActiveRef.current) { rafRef.current = requestAnimationFrame(loop); return; }

      // --- Update particles ---
      const pts = particlesRef.current;
      if (pts.length > 0) {
        for (const p of pts) { p.x += p.vx; p.y += p.vy; p.vy += 0.04; p.alpha -= p.decay; }
        particlesRef.current = pts.filter(p => p.alpha > 0);
      }

      // --- Draw canvas directly (no React re-render needed) ---
      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const cs = cellSizeRef.current || 32;
          const W = COLS * cs, H = ROWS * cs;
          const s = stateRef.current;
          const { board, current, gameOver } = s;

          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, W, H);

          // Grid (batched)
          ctx.strokeStyle = "rgba(255,255,255,0.10)";
          ctx.lineWidth = 0.5;
          ctx.beginPath();
          for (let r = 0; r <= ROWS; r++) { ctx.moveTo(0, r * cs); ctx.lineTo(W, r * cs); }
          for (let c = 0; c <= COLS; c++) { ctx.moveTo(c * cs, 0); ctx.lineTo(c * cs, H); }
          ctx.stroke();

          if (!gameOver) {
            // Locked board cells
            for (let r = 0; r < ROWS; r++)
              for (let c = 0; c < COLS; c++)
                if (board[r][c]) drawCell(ctx, c, r, board[r][c] as string, "", cs);

            // Ghost
            const ghost = ghostPosition(board, current);
            const tet = TETROMINOES[current.type];
            ctx.strokeStyle = tet.color + "55";
            ctx.lineWidth = 1.5;
            ctx.fillStyle = tet.color + "18";
            for (let r = 0; r < ghost.shape.length; r++)
              for (let c = 0; c < ghost.shape[r].length; c++) {
                if (!ghost.shape[r][c]) continue;
                const gx = (ghost.x + c) * cs, gy = (ghost.y + r) * cs;
                ctx.fillRect(gx + 1, gy + 1, cs - 2, cs - 2);
                ctx.strokeRect(gx + 1.5, gy + 1.5, cs - 3, cs - 3);
              }

            // Active piece (with glow, ~4 cells)
            for (let r = 0; r < current.shape.length; r++)
              for (let c = 0; c < current.shape[r].length; c++)
                if (current.shape[r][c]) drawCellGlow(ctx, current.x + c, current.y + r, tet.color, tet.glow, cs);
          }

          const reduceVfx = reduceEffectsRef.current;

          // Place flash
          const pf = placeFlashRef.current;
          if (!reduceVfx && pf) {
            const el = Date.now() - pf.start;
            const a = Math.max(0, 1 - el / 180);
            if (a > 0) {
              ctx.save();
              pf.cells.forEach(({ x, y, color }) => {
                ctx.globalAlpha = a * 0.75;
                ctx.shadowBlur = 20; ctx.shadowColor = color;
                ctx.fillStyle = "#ffffff";
                ctx.fillRect(x * cs + 1, y * cs + 1, cs - 2, cs - 2);
              });
              ctx.restore();
            } else {
              placeFlashRef.current = null;
            }
          }

          // Line-clear flash
          const lc = reduceVfx ? null : lineClearAnimRef.current;
          if (lc) {
            const t = Math.min(1, (Date.now() - lc.startTime) / 350);
            const alpha = 1 - t;
            ctx.save();
            ctx.shadowBlur = 30; ctx.shadowColor = "#ffffff";
            for (const row of lc.rows) {
              ctx.globalAlpha = alpha * 0.9;
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(0, row * cs, W, cs);
            }
            for (const { r, c, color } of lc.cells) {
              ctx.globalAlpha = alpha * 0.5;
              ctx.fillStyle = color;
              ctx.fillRect(c * cs + 1, r * cs + 1, cs - 2, cs - 2);
            }
            ctx.restore();
          }

          // Particles
          if (!reduceVfx && particlesRef.current.length > 0) {
            ctx.save();
            for (const p of particlesRef.current) {
              ctx.globalAlpha = p.alpha;
              ctx.fillStyle = p.color;
              const sz = p.size * p.alpha;
              ctx.fillRect(p.x - sz / 2, p.y - sz / 2, sz, sz);
            }
            ctx.restore();
          }

          // Game-over overlay — cascade + shockwave + vignette
          if (gameOver) {
            const since = Date.now() - gameOverTimeRef.current;

            if (!reduceVfx) {
              const rowDelay = 22;
              // Row cascade: each row flashes red from bottom → top
              for (let r = ROWS - 1; r >= 0; r--) {
                const rowStart = (ROWS - 1 - r) * rowDelay;
                const rs = since - rowStart;
                if (rs <= 0) continue;
                const peak = 80, fade = 160;
                let rowAlpha = 0;
                if (rs < peak) rowAlpha = rs / peak;
                else if (rs < peak + fade) rowAlpha = 1 - (rs - peak) / fade;
                if (rowAlpha <= 0) continue;
                ctx.save();
                ctx.globalAlpha = rowAlpha * 0.92;
                ctx.fillStyle = `rgb(220,30,30)`;
                ctx.shadowBlur = 18; ctx.shadowColor = '#ff0000';
                ctx.fillRect(0, r * cs, W, cs);
                ctx.restore();
              }

              // Shockwave ring expanding from centre (starts at 60ms)
              if (since > 60 && since < 700) {
                const t = (since - 60) / 640;
                const maxR = Math.sqrt(W * W + H * H) / 1.6;
                const radius = t * maxR;
                const ringAlpha = Math.max(0, 1 - t);
                ctx.save();
                ctx.globalAlpha = ringAlpha * 0.85;
                ctx.strokeStyle = '#ff3030';
                ctx.lineWidth = cs * 0.6 * (1 - t * 0.7) + 1;
                ctx.shadowBlur = 40; ctx.shadowColor = '#ff0000';
                ctx.beginPath();
                ctx.arc(W / 2, H / 2, radius, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = ringAlpha * 0.4;
                ctx.strokeStyle = '#ff8080';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(W / 2, H / 2, radius * 0.6, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
              }
            }

            // Dark red-tinted overlay fades in (always shown, even with reduceVfx)
            if (since > 200) {
              const fadeAlpha = Math.min(0.88, (since - 200) / 350);
              ctx.save();
              ctx.globalAlpha = fadeAlpha;
              const grad = ctx.createRadialGradient(W/2, H/2, 0, W/2, H/2, Math.max(W,H)*0.8);
              grad.addColorStop(0, 'rgba(12,0,0,0.94)');
              grad.addColorStop(0.6, 'rgba(6,0,0,0.97)');
              grad.addColorStop(1, 'rgba(20,0,0,1)');
              ctx.fillStyle = grad;
              ctx.fillRect(0, 0, W, H);
              ctx.restore();
            }

            if (!reduceVfx) {
              // Scanlines overlay
              if (since > 280) {
                const scanAlpha = Math.min(0.18, (since - 280) / 200 * 0.18);
                ctx.save();
                ctx.globalAlpha = scanAlpha;
                ctx.fillStyle = '#000';
                for (let sy = 0; sy < H; sy += 3) ctx.fillRect(0, sy, W, 1);
                ctx.restore();
              }

              // Horizontal glitch slices (occasional, 400–800ms)
              if (since > 400 && since < 820) {
                const t = (since - 400) / 420;
                const flicker = Math.sin(since * 0.047) > 0.5;
                if (flicker) {
                  ctx.save();
                  ctx.globalAlpha = 0.13 * (1 - t);
                  const sliceY = (Math.sin(since * 0.11) * 0.5 + 0.5) * H;
                  const sliceH = cs * (0.3 + Math.abs(Math.sin(since * 0.07)) * 0.7);
                  ctx.fillStyle = 'rgba(255,40,40,0.6)';
                  ctx.fillRect(0, sliceY, W, sliceH);
                  ctx.restore();
                }
              }
            }
          }
        }
      }

      rafRef.current = requestAnimationFrame(loop);
    }
    rafRef.current = requestAnimationFrame(loop);
    return () => { active = false; cancelAnimationFrame(rafRef.current); };
  }, []);

  // Spawn particles when a line is cleared; RAF loop drives re-renders
  useEffect(() => {
    if (!lineClearAnim) return;
    const cs = cellSize || 32;
    for (const { r, c, color } of lineClearAnim.cells) {
      const glow = getGlow(color);
      const baseX = c * cs + cs / 2;
      const baseY = r * cs + cs / 2;
      const count = 5 + Math.floor(Math.random() * 3);
      for (let i = 0; i < count; i++) {
        particlesRef.current.push({
          x: baseX + (Math.random() - 0.5) * cs * 0.5,
          y: baseY + (Math.random() - 0.5) * cs * 0.5,
          vx: (Math.random() - 0.4) * 9,
          vy: (Math.random() - 0.65) * 6,
          color, glow,
          size: cs * (0.28 + Math.random() * 0.24),
          alpha: 1,
          decay: 0.006 + Math.random() * 0.006,
        });
      }
    }
    const clearId = setTimeout(() => setLineClearAnim(null), 370);
    return () => clearTimeout(clearId);
  }, [lineClearAnim, cellSize]);

  // Keep cellSizeRef and isMobileRef in sync so RAF loop can read them
  cellSizeRef.current = cellSize;
  isMobileRef.current = isMobile;

  const nextCellSize = isMobile ? 18 : 22;
  useEffect(() => {
    const canvas = nextCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    const tet = TETROMINOES[state.next];
    const shape = tet.shape;
    const rows = shape.length, cols = shape[0].length;
    const offX = Math.floor((W / nextCellSize - cols) / 2);
    const offY = Math.floor((H / nextCellSize - rows) / 2);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (!shape[r][c]) continue;
        ctx.save();
        ctx.shadowBlur = 14; ctx.shadowColor = tet.glow; ctx.fillStyle = tet.color;
        ctx.fillRect((offX + c) * nextCellSize + 1, (offY + r) * nextCellSize + 1, nextCellSize - 2, nextCellSize - 2);
        ctx.shadowBlur = 4; ctx.shadowColor = "#ffffff88"; ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.fillRect((offX + c) * nextCellSize + 1 + nextCellSize * 0.15, (offY + r) * nextCellSize + 1 + nextCellSize * 0.15, nextCellSize - 2 - nextCellSize * 0.3, 3);
        ctx.restore();
      }
  }, [state.next, nextCellSize, screen]);

  // Draw hold piece canvas
  useEffect(() => {
    const canvas = holdCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, W, H);
    if (!state.hold) return;
    const tet = TETROMINOES[state.hold];
    const shape = tet.shape;
    const rows = shape.length, cols = shape[0].length;
    const offX = Math.floor((W / nextCellSize - cols) / 2);
    const offY = Math.floor((H / nextCellSize - rows) / 2);
    const alpha = state.canHold ? 1 : 0.35;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (!shape[r][c]) continue;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.shadowBlur = 14; ctx.shadowColor = tet.glow; ctx.fillStyle = tet.color;
        ctx.fillRect((offX + c) * nextCellSize + 1, (offY + r) * nextCellSize + 1, nextCellSize - 2, nextCellSize - 2);
        ctx.shadowBlur = 4; ctx.shadowColor = "#ffffff88"; ctx.fillStyle = "rgba(255,255,255,0.18)";
        ctx.fillRect((offX + c) * nextCellSize + 1 + nextCellSize * 0.15, (offY + r) * nextCellSize + 1 + nextCellSize * 0.15, nextCellSize - 2 - nextCellSize * 0.3, 3);
        ctx.restore();
      }
  }, [state.hold, state.canHold, nextCellSize, screen]);

  const canvasW = COLS * cellSize;
  const canvasH = ROWS * cellSize;
  const nextW = 5 * nextCellSize;
  const nextH = 4 * nextCellSize;

  // Delayed game-over overlay — wait for canvas cascade to finish
  const [showGameOverOverlay, setShowGameOverOverlay] = useState(false);
  useEffect(() => {
    if (state.gameOver) {
      const t = setTimeout(() => setShowGameOverOverlay(true), 720);
      return () => clearTimeout(t);
    } else {
      setShowGameOverOverlay(false);
      return undefined;
    }
  }, [state.gameOver]);

  // Go-home loading overlay (rendered globally on top of everything)
  const goHomeOverlay = goHomeLoading ? (
    <div style={{ position: 'fixed', inset: 0, zIndex: 99999, background: '#000812', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24 }}>
      <div style={{ fontSize: 'clamp(12px, 2.5vw, 18px)', fontFamily: '"Orbitron", monospace', fontWeight: 700, color: '#00f0f0', letterSpacing: '0.4em', textShadow: '0 0 20px #00f0f0' }}>LANC PROJECT</div>
      <div style={{ width: 'clamp(180px, 50vw, 320px)', height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 2, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${goHomeProg}%`, background: 'linear-gradient(90deg, #00608088, #00f0f0)', borderRadius: 2, boxShadow: '0 0 12px #00f0f0', transition: 'width 0.03s linear' }} />
      </div>
      <div style={{ fontSize: 9, fontFamily: '"Orbitron", monospace', letterSpacing: '0.5em', color: 'rgba(0,240,240,0.5)' }}>LOADING...</div>
    </div>
  ) : null;

  // Unified game-over overlay (both modes) — hidden in multi_game
  const competitiveResult = showGameOverOverlay && screen !== 'multi_game' ? (
    <GameOverOverlay
      score={state.score}
      lines={state.lines}
      elapsed={state.elapsed}
      gameMode={gameMode}
      onRetry={() => dispatch({ type: "RESTART" })}
      onHome={handleGoHome}
    />
  ) : null;
  const multiDeadOverlay = showGameOverOverlay && screen === 'multi_game' && !multiGameResult ? (
    <div style={{ position:'fixed', inset:0, zIndex:9000, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'rgba(0,0,0,0.72)', fontFamily:'"Orbitron",monospace', userSelect:'none' }}>
      <div style={{ fontSize:'clamp(22px,5vw,40px)', fontWeight:900, color:'#ff2828', letterSpacing:'0.12em', textShadow:'0 0 32px #ff2828', marginBottom:16 }}>YOU DIED</div>
      <div style={{ fontSize:'clamp(9px,1.5vw,12px)', color:'rgba(0,240,240,0.55)', letterSpacing:'0.35em', marginBottom:36 }}>WAITING FOR RESULTS...</div>
      <button onClick={handleGoHome} style={{ padding:'10px 28px', background:'transparent', border:'1px solid rgba(0,240,240,0.35)', borderRadius:5, color:'rgba(0,240,240,0.7)', fontFamily:'"Orbitron",monospace', fontWeight:700, fontSize:9, letterSpacing:'0.3em', cursor:'pointer', outline:'none' }}>◀ LEAVE</button>
    </div>
  ) : null;

  const multiResultOverlay = multiGameResult && screen === 'multi_game' ? (() => {
    const { result } = multiGameResult;
    const myRank = result.findIndex(p => p.id === myPlayerId) + 1;
    const isWinner = myRank === 1;
    const myEntry = result.find(p => p.id === myPlayerId);
    const accent = isWinner ? '#00e060' : '#ff2828';
    const accentDim = isWinner ? 'rgba(0,224,96,0.15)' : 'rgba(255,40,40,0.12)';
    const handleBack = () => {
      setMultiGameResult(null);
      setScreen('room_wait');
    };
    return (
      <div style={{ position:'fixed', inset:0, zIndex:9100, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'rgba(0,4,14,0.92)', fontFamily:'"Orbitron",monospace', userSelect:'none' }}>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:8, padding:'32px 40px', border:`1px solid ${accent}44`, borderRadius:12, background:accentDim, minWidth:'clamp(260px,80vw,400px)', maxWidth:440 }}>
          <div style={{ fontSize:'clamp(26px,6vw,46px)', fontWeight:900, color:accent, letterSpacing:'0.1em', textShadow:`0 0 30px ${accent}`, marginBottom:4 }}>
            {isWinner ? '🏆 WINNER!' : `RANK #${myRank}`}
          </div>
          <div style={{ fontSize:'clamp(11px,2.5vw,16px)', color:'rgba(255,255,255,0.55)', letterSpacing:'0.3em', marginBottom:12 }}>
            {isWinner ? 'VICTORY' : 'GAME OVER'}
          </div>
          <div style={{ display:'flex', gap:20, marginBottom:20, justifyContent:'center' }}>
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:9, letterSpacing:'0.3em', color:'rgba(255,255,255,0.4)', marginBottom:4 }}>TIME</div>
              <div style={{ fontSize:'clamp(16px,3.5vw,24px)', fontWeight:700, color:accent, letterSpacing:'0.06em' }}>{formatTime(myEntry?.time ?? 0)}</div>
            </div>
            <div style={{ width:1, background:`${accent}33` }} />
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:9, letterSpacing:'0.3em', color:'rgba(255,255,255,0.4)', marginBottom:4 }}>SCORE</div>
              <div style={{ fontSize:'clamp(16px,3.5vw,24px)', fontWeight:700, color:'#fff', letterSpacing:'0.06em' }}>{(myEntry?.score ?? 0).toLocaleString()}</div>
            </div>
            <div style={{ width:1, background:`${accent}33` }} />
            <div style={{ textAlign:'center' }}>
              <div style={{ fontSize:9, letterSpacing:'0.3em', color:'rgba(255,255,255,0.4)', marginBottom:4 }}>LINES</div>
              <div style={{ fontSize:'clamp(16px,3.5vw,24px)', fontWeight:700, color:'#fff', letterSpacing:'0.06em' }}>{myEntry?.lines ?? 0}</div>
            </div>
          </div>
          <div style={{ width:'100%', borderTop:`1px solid ${accent}33`, paddingTop:14, display:'flex', flexDirection:'column', gap:6 }}>
            {result.map((p, i) => {
              const isMe = p.id === myPlayerId;
              return (
                <div key={p.id} style={{ display:'flex', alignItems:'center', gap:10, padding:'6px 10px', borderRadius:6, background: isMe ? `${accent}22` : 'transparent', border: isMe ? `1px solid ${accent}44` : '1px solid transparent' }}>
                  <span style={{ width:22, textAlign:'center', fontSize:11, color: i === 0 ? '#ffd700' : 'rgba(255,255,255,0.4)', fontWeight:700 }}>#{i+1}</span>
                  <span style={{ flex:1, fontSize:11, color: isMe ? '#fff' : 'rgba(255,255,255,0.6)', letterSpacing:'0.15em' }}>{p.name}{isMe ? ' ◀' : ''}</span>
                  <span style={{ fontSize:11, color:'rgba(255,255,255,0.4)', marginRight:4 }}>{(p.score).toLocaleString()}</span>
                  <span style={{ fontSize:11, color: isMe ? accent : 'rgba(255,255,255,0.5)', fontWeight:700 }}>{formatTime(p.time)}</span>
                </div>
              );
            })}
          </div>
          <button onClick={handleBack} style={{ marginTop:18, padding:'10px 32px', background:'transparent', border:`1px solid ${accent}88`, borderRadius:6, color:accent, fontFamily:'"Orbitron",monospace', fontWeight:700, fontSize:10, letterSpacing:'0.3em', cursor:'pointer', outline:'none' }}>
            ◀ BACK TO ROOM
          </button>
        </div>
      </div>
    );
  })() : null;

  // Permanent top-left home button
  const homeBtn = (
    <button onClick={handleGoHome} style={{
      position: 'fixed', top: 12, left: 12, zIndex: 8000,
      padding: '6px 14px', background: 'transparent',
      border: '1px solid rgba(0,240,240,0.35)', borderRadius: 5,
      color: 'rgba(0,240,240,0.7)', fontFamily: '"Orbitron", monospace', fontWeight: 700,
      fontSize: 9, letterSpacing: '0.25em', cursor: 'pointer', outline: 'none',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(0,240,240,0.08)'; e.currentTarget.style.color = '#00f0f0'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'rgba(0,240,240,0.7)'; }}
    >◀ HOME</button>
  );

  if (screen === 'loading')    return <>{goHomeOverlay}<LoadingScreen onDone={handleLoadingDone} /></>;
  if (screen === 'home')       return (
    <>
      {goHomeOverlay}
      <HomeScreen
        onStart={handleGoModeSelect}
        onMultiplayer={() => {
          setCurrentRoom(null);
          setOtherBoards({});
          setScreen('multiplayer');
          try { getSocket().emit('get_rooms'); } catch (_) {}
        }}
        onOpenSettings={() => setShowSettings(true)}
      />
      {showSettings && (
        <SettingsOverlay
          settings={settings}
          onSave={s => { setSettings(s); saveSettings(s); }}
          onClose={() => setShowSettings(false)}
          isMobile={isMobile}
        />
      )}
    </>
  );
  if (screen === 'modeselect') return <>{goHomeOverlay}<ModeSelectScreen onSelect={handleStartGame} onGoHome={() => setScreen('home')} /></>;
  if (screen === 'countdown')  return <>{cdTransitionOverlay}<CountdownScreen onDone={handleCountdownDone} /></>;

  if (screen === 'multiplayer') return (
    <MultiplayerLobby
      rooms={multiRooms}
      onBack={() => setScreen('home')}
      onCreate={() => setScreen('room_create')}
      onJoin={(roomId, passkey) => { try { getSocket().emit('join_room', { roomId, passkey }); } catch (_) {} }}
      onRefresh={() => { try { getSocket().emit('get_rooms'); } catch (_) {} }}
    />
  );
  if (screen === 'room_create') return (
    <RoomCreateScreen
      onBack={() => setScreen('multiplayer')}
      onCreate={(name, maxPlayers, passkey) => {
        try { getSocket().emit('create_room', { name, maxPlayers, passkey }); } catch (_) {}
      }}
    />
  );
  if (screen === 'room_wait' && currentRoom) return (
    <RoomWaitScreen
      room={currentRoom}
      myId={myPlayerId}
      onBack={() => {
        try { getSocket().emit('leave_room'); } catch (_) {}
        setCurrentRoom(null);
        setScreen('multiplayer');
        try { getSocket().emit('get_rooms'); } catch (_) {}
      }}
      onStart={() => { try { getSocket().emit('start_game'); } catch (_) {} }}
    />
  );
  if (screen === 'multi_countdown') return <CountdownScreen onDone={() => {}} isMulti />;

  if (isMobile) {
    return (
      <>
        {cdTransitionOverlay}
        {goHomeOverlay}
        {competitiveResult}
        {multiDeadOverlay}
        {multiResultOverlay}
        {homeBtn}
        {screen === 'multi_game' && <GhostBoards boards={Object.values(otherBoards)} />}
        <div style={{ background: "linear-gradient(180deg, #000812 0%, #000508 100%)", minHeight: "100dvh", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", userSelect: "none", overflow: "hidden" }}>
          <div style={{ display: "flex", width: "100%", justifyContent: "center", alignItems: "flex-start", gap: 8, padding: "48px 8px 4px" }}>
            {/* Left panel — HOLD */}
            <div style={{ display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
              <div style={{ borderLeft: "3px solid rgba(0,170,255,0.8)", borderTop: "1px solid rgba(0,170,255,0.2)", borderRight: "1px solid rgba(0,170,255,0.1)", borderBottom: "1px solid rgba(0,170,255,0.1)", borderRadius: "0 5px 5px 0", padding: "5px 6px", background: "linear-gradient(135deg, #010d18, #021828)", boxShadow: "0 0 14px rgba(0,170,255,0.15)" }}>
                <div style={{ color: "rgba(0,170,255,0.75)", fontSize: 7, letterSpacing: "0.2em", marginBottom: 3, fontFamily: '"Orbitron", monospace', fontWeight: 500 }}>HOLD</div>
                <canvas ref={holdCanvasRef} width={nextW} height={nextH} style={{ display: "block", opacity: state.canHold ? 1 : 0.35, transition: "opacity 0.2s" }} />
              </div>
            </div>
            <canvas ref={canvasRef} width={canvasW} height={canvasH} style={{ border: "2px solid rgba(0,240,240,0.45)", boxShadow: "0 0 28px rgba(0,240,240,0.18), 0 0 6px rgba(0,240,240,0.1)", flexShrink: 0 }} />
            <div style={{ display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
              <MiniPanel label="SCORE" value={state.score.toLocaleString()} color="#00f0f0" />
              <MiniPanel label="LVL" value={String(state.level)} color="#a0c0ff" />
              <div style={{ borderLeft: "3px solid rgba(160,0,240,0.8)", borderTop: "1px solid rgba(160,0,240,0.2)", borderRight: "1px solid rgba(160,0,240,0.1)", borderBottom: "1px solid rgba(160,0,240,0.1)", borderRadius: "0 5px 5px 0", padding: "5px 6px", background: "linear-gradient(135deg, #060210, #0d0420)", boxShadow: "0 0 14px rgba(160,0,240,0.15)" }}>
                <div style={{ color: "rgba(160,0,240,0.75)", fontSize: 7, letterSpacing: "0.2em", marginBottom: 3, fontFamily: '"Orbitron", monospace', fontWeight: 500 }}>NEXT</div>
                <canvas ref={nextCanvasRef} width={nextW} height={nextH} style={{ display: "block" }} />
              </div>
              <MiniPanel label="TIME" value={formatTime(state.elapsed)} color="#00f060" />
              <MiniPanel label="LINES" value={String(state.lines)} color="#f0a000" />
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 9, padding: "10px 16px 14px", width: "100%", background: "linear-gradient(180deg, transparent 0%, rgba(0,4,16,0.97) 18%)", borderTop: "1px solid rgba(0,200,255,0.07)", marginTop: 2, position: "relative", zIndex: 5 }}>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", width: "100%" }}>
              <div style={{ transform: `translate(${settings.buttonOffsets.hold.x}px,${settings.buttonOffsets.hold.y}px)`, flexShrink: 0 }}>
                <HoldBtn onPress={() => { audio.playHold(); dispatch({ type: "HOLD" }); }} canHold={state.canHold} />
              </div>
              <div style={{ transform: `translate(${settings.buttonOffsets.rotate.x}px,${settings.buttonOffsets.rotate.y}px)`, flexShrink: 0 }}>
                <TouchBtn onPress={() => { audio.playRotate(); dispatch({ type: "ROTATE" }); }} label="ROTATE" color="#a000f0" wide />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", width: "100%" }}>
              <div style={{ transform: `translate(${settings.buttonOffsets.left.x}px,${settings.buttonOffsets.left.y}px)`, flexShrink: 0 }}>
                <TouchBtn onPress={() => { audio.playMove(); dispatch({ type: "MOVE_LEFT" }); }} label="◀" color="#00aaff" size={64} repeat />
              </div>
              <div style={{ transform: `translate(${settings.buttonOffsets.down.x}px,${settings.buttonOffsets.down.y}px)`, flexShrink: 0 }}>
                <TouchBtn onPress={() => { audio.playSoftDrop(); dispatch({ type: "MOVE_DOWN" }); }} label="↓" color="#00f060" size={64} repeat />
              </div>
              <div style={{ transform: `translate(${settings.buttonOffsets.right.x}px,${settings.buttonOffsets.right.y}px)`, flexShrink: 0 }}>
                <TouchBtn onPress={() => { audio.playMove(); dispatch({ type: "MOVE_RIGHT" }); }} label="▶" color="#00aaff" size={64} repeat />
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", width: "100%" }}>
              <div style={{ transform: `translate(${settings.buttonOffsets.drop.x}px,${settings.buttonOffsets.drop.y}px)`, flexShrink: 0 }}>
                <TouchBtn onPress={() => { audio.playHardDrop(); dispatch({ type: "HARD_DROP" }); }} label="DROP" color="#f0a000" wide />
              </div>
              {gameMode !== 'competitive' && screen !== 'multi_game'
                ? (
                  <div style={{ transform: `translate(${settings.buttonOffsets.retry.x}px,${settings.buttonOffsets.retry.y}px)`, flexShrink: 0 }}>
                    <TouchBtn onPress={() => dispatch({ type: "RESTART" })} label="RETRY" color="#f04040" wide />
                  </div>
                )
                : <div style={{ flex: 1, maxWidth: 120 }} />}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {cdTransitionOverlay}
      {goHomeOverlay}
      {competitiveResult}
      {multiDeadOverlay}
      {multiResultOverlay}
      {homeBtn}
      {screen === 'multi_game' && <GhostBoards boards={Object.values(otherBoards)} />}
      <div style={{ background: "linear-gradient(180deg, #000812 0%, #000508 100%)", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: '"Orbitron", monospace' }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 24 }}>
          {/* Left panel — HOLD */}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 120 }}>
            <Panel label="HOLD" color="#00aaff">
              <canvas ref={holdCanvasRef} width={nextW} height={nextH} style={{ display: "block", opacity: state.canHold ? 1 : 0.35, transition: "opacity 0.2s" }} />
            </Panel>
            <div style={{ fontSize: 8, fontFamily: '"Orbitron", monospace', color: "rgba(0,170,255,0.3)", letterSpacing: "0.3em", textAlign: "center" }}>[ H ]</div>
          </div>
          <canvas ref={canvasRef} width={canvasW} height={canvasH} style={{ border: "2px solid rgba(0,240,240,0.45)", display: "block", boxShadow: "0 0 32px rgba(0,240,240,0.18), 0 0 8px rgba(0,240,240,0.1)" }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 145 }}>
            <Panel label="SCORE" color="#00f0f0">
              <span style={{ color: "#00f0f0", fontSize: 22, fontWeight: 700, fontFamily: '"Orbitron", monospace', textShadow: "0 0 10px #00f0f077" }}>{state.score.toLocaleString()}</span>
            </Panel>
            <Panel label="LEVEL" color="#a0c0ff">
              <span style={{ color: "#a0c0ff", fontSize: 20, fontWeight: 700, fontFamily: '"Orbitron", monospace', textShadow: "0 0 10px #a0c0ff77" }}>{state.level}</span>
            </Panel>
            <Panel label="NEXT" color="#a000f0">
              <canvas ref={nextCanvasRef} width={nextW} height={nextH} style={{ display: "block" }} />
            </Panel>
            <Panel label="TIME" color="#00f060">
              <span style={{ color: "#00f060", fontSize: 18, fontWeight: 700, fontFamily: '"Orbitron", monospace', textShadow: "0 0 10px #00f06077" }}>{formatTime(state.elapsed)}</span>
            </Panel>
            <Panel label="LINES" color="#f0a000">
              <span style={{ color: "#f0a000", fontSize: 20, fontWeight: 700, fontFamily: '"Orbitron", monospace', textShadow: "0 0 10px #f0a00077" }}>{state.lines}</span>
            </Panel>
          </div>
        </div>
      </div>
    </>
  );
}

function Panel({ label, children, color = "#446" }: { label: string; children: React.ReactNode; color?: string }) {
  return (
    <div style={{ borderLeft: `3px solid ${color}`, borderTop: `1px solid ${color}33`, borderRight: `1px solid ${color}18`, borderBottom: `1px solid ${color}18`, borderRadius: "0 6px 6px 0", padding: "10px 14px 10px 12px", background: "linear-gradient(135deg, #060a16, #0d1228)", boxShadow: `0 0 16px ${color}22` }}>
      <div style={{ color: `${color}99`, fontSize: 9, letterSpacing: "0.2em", marginBottom: 6, fontFamily: '"Orbitron", monospace', fontWeight: 500 }}>{label}</div>
      {children}
    </div>
  );
}

function MiniPanel({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ borderLeft: `3px solid ${color}`, borderTop: `1px solid ${color}22`, borderRight: `1px solid ${color}11`, borderBottom: `1px solid ${color}11`, borderRadius: "0 5px 5px 0", padding: "5px 8px 5px 9px", background: "linear-gradient(135deg, #060a16, #0d1228)", minWidth: 62, boxShadow: `0 0 14px ${color}18` }}>
      <div style={{ color: `${color}88`, fontSize: 7, letterSpacing: "0.2em", marginBottom: 3, fontFamily: '"Orbitron", monospace', fontWeight: 500 }}>{label}</div>
      <div style={{ color, fontSize: 13, fontWeight: 700, fontFamily: '"Orbitron", monospace', letterSpacing: "0.04em", textShadow: `0 0 8px ${color}77` }}>{value}</div>
    </div>
  );
}

function HoldBtn({ onPress, canHold }: { onPress: () => void; canHold: boolean }) {
  const [pressed, setPressed] = useState(false);
  const handleTouchStart = useCallback((e: React.TouchEvent) => { e.preventDefault(); setPressed(true); }, []);
  const handleTouchEnd = useCallback((e: React.TouchEvent) => { e.preventDefault(); if (pressed) { setPressed(false); onPress(); } }, [onPress, pressed]);
  const handleTouchCancel = useCallback((e: React.TouchEvent) => { e.preventDefault(); setPressed(false); }, []);

  const c = canHold ? "#00d4ff" : "#334455";
  const glow = canHold
    ? pressed
      ? `0 0 28px #00d4ffbb, 0 0 10px #00d4ff66, inset 0 0 16px #00d4ff18`
      : `0 0 14px #00d4ff44, 0 0 5px #00d4ff22, inset 0 0 8px #00d4ff0a`
    : "none";

  return (
    <button
      onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchCancel} onClick={onPress}
      style={{
        width: 136, height: 62, position: "relative", background: "transparent", border: "none",
        padding: 0, cursor: "pointer", WebkitTapHighlightColor: "transparent",
        outline: "none", userSelect: "none", WebkitUserSelect: "none", flexShrink: 0,
        transform: pressed ? "scale(0.91) translateY(1px)" : "scale(1)",
        transition: "transform 0.06s, opacity 0.2s",
        opacity: canHold ? 1 : 0.42,
      }}
    >
      <style>{`
        @keyframes holdPulse {
          0%,100% { opacity:0.55; } 50% { opacity:1; }
        }
      `}</style>

      {/* Main body — clipped octagon */}
      <div style={{
        position: "absolute", inset: 0,
        clipPath: "polygon(10px 0%,100% 0%,100% calc(100% - 10px),calc(100% - 10px) 100%,0% 100%,0% 10px)",
        background: pressed
          ? `linear-gradient(145deg,#00d4ff28,#00d4ff14)`
          : `linear-gradient(145deg,#00d4ff10,#00d4ff06)`,
        border: `1.5px solid ${pressed ? "#00d4ffaa" : "#00d4ff40"}`,
        boxShadow: glow,
        transition: "background 0.06s, border-color 0.06s, box-shadow 0.06s",
      }} />

      {/* Corner accents */}
      {[
        { top: 0,   left:  0, borderTop: `2px solid ${c}`, borderLeft:  `2px solid ${c}` },
        { top: 0,   right: 0, borderTop: `2px solid ${c}`, borderRight: `2px solid ${c}` },
        { bottom:0, left:  0, borderBottom:`2px solid ${c}`,borderLeft: `2px solid ${c}` },
        { bottom:0, right: 0, borderBottom:`2px solid ${c}`,borderRight:`2px solid ${c}` },
      ].map((s, i) => (
        <div key={i} style={{ position:"absolute", width:10, height:10, pointerEvents:"none", ...s,
          opacity: pressed ? 1 : canHold ? 0.8 : 0.4, transition:"opacity 0.2s" }} />
      ))}

      {/* Pulse ring when available */}
      {canHold && !pressed && (
        <div style={{
          position:"absolute", inset:3, borderRadius:4,
          border:"1px solid #00d4ff30",
          animation:"holdPulse 2s ease-in-out infinite",
          pointerEvents:"none",
        }} />
      )}

      {/* Icon + label */}
      <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:2, pointerEvents:"none" }}>
        {/* Custom SVG: two inward arrows flanking a box */}
        <svg width="34" height="18" viewBox="0 0 34 18" style={{ pointerEvents:"none" }}>
          <rect x="11" y="3" width="12" height="12" rx="2"
            fill={pressed ? "#00d4ff30" : "#00d4ff14"}
            stroke={pressed ? "#00d4ffcc" : "#00d4ff70"} strokeWidth="1.5" />
          {/* Left arrow → */}
          <polyline points="2,9 9,9" stroke={pressed?"#fff":"#00d4ff"} strokeWidth="1.5" strokeLinecap="round"/>
          <polyline points="6,6 9,9 6,12" stroke={pressed?"#fff":"#00d4ff"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          {/* Right arrow ← */}
          <polyline points="32,9 25,9" stroke={pressed?"#fff":"#00d4ff"} strokeWidth="1.5" strokeLinecap="round"/>
          <polyline points="28,6 25,9 28,12" stroke={pressed?"#fff":"#00d4ff"} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
          {/* Small tetromino silhouette inside box */}
          <rect x="13.5" y="5.5" width="3" height="3" rx="0.5" fill={pressed?"#fff":"#00d4ff"} opacity={pressed?0.9:0.6}/>
          <rect x="16.5" y="5.5" width="3" height="3" rx="0.5" fill={pressed?"#fff":"#00d4ff"} opacity={pressed?0.9:0.6}/>
          <rect x="16.5" y="8.5" width="3" height="3" rx="0.5" fill={pressed?"#fff":"#00d4ff"} opacity={pressed?0.9:0.6}/>
        </svg>
        <span style={{
          fontFamily:'"Orbitron",monospace', fontWeight:900, fontSize:9,
          letterSpacing:"0.45em", color: pressed ? "#fff" : "#00d4ff",
          textShadow: pressed ? `0 0 12px #00d4ff,0 0 4px #ffffff88` : `0 0 8px #00d4ff66`,
          lineHeight:1,
        }}>HOLD</span>
      </div>
    </button>
  );
}

function TouchBtn({ onPress, label, color, wide, size, repeat }: {
  onPress: () => void;
  label: string;
  color: string;
  wide?: boolean;
  size?: number;
  repeat?: boolean;
}) {
  const [pressed, setPressed] = useState(false);
  const repeatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  const stopRepeat = useCallback(() => {
    if (repeatTimer.current)   { clearTimeout(repeatTimer.current);  repeatTimer.current = null; }
    if (repeatInterval.current){ clearInterval(repeatInterval.current); repeatInterval.current = null; }
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    setPressed(true);
    onPressRef.current();
    if (repeat) {
      repeatTimer.current = setTimeout(() => {
        repeatInterval.current = setInterval(() => onPressRef.current(), 55);
      }, 180);
    }
  }, [repeat, stopRepeat]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    e.preventDefault();
    setPressed(false);
    if (repeat) { stopRepeat(); } else { onPressRef.current(); }
  }, [repeat, stopRepeat]);

  const handleTouchCancel = useCallback((e: React.TouchEvent) => { e.preventDefault(); setPressed(false); stopRepeat(); }, [stopRepeat]);

  const w = wide ? 136 : (size || 62);
  const h = size || 62;
  const cut = wide ? 10 : 7;
  const c = pressed ? "#fff" : color;
  const sp = { stroke: c, strokeWidth: "2" as const, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" as const };
  const dropFx = { filter: `drop-shadow(0 0 ${pressed ? 7 : 3}px ${color})`, pointerEvents: "none" as const };

  const iconEl = (() => {
    if (label === "◀") return (
      <svg width="26" height="26" viewBox="0 0 26 26" style={dropFx}>
        <polyline points="16,5 9,13 16,21" {...sp} strokeWidth="2.4"/>
      </svg>
    );
    if (label === "▶") return (
      <svg width="26" height="26" viewBox="0 0 26 26" style={dropFx}>
        <polyline points="10,5 17,13 10,21" {...sp} strokeWidth="2.4"/>
      </svg>
    );
    if (label === "↓") return (
      <svg width="26" height="26" viewBox="0 0 26 26" style={dropFx}>
        <line x1="13" y1="4" x2="13" y2="18" {...sp} strokeWidth="2.4"/>
        <polyline points="8,13 13,19 18,13" {...sp} strokeWidth="2.4"/>
      </svg>
    );
    if (label === "ROTATE") return (
      <span style={{ fontSize: 24, lineHeight: 1, pointerEvents: "none", filter: `drop-shadow(0 0 ${pressed ? 7 : 3}px ${color})`, color: c }}>↻</span>
    );
    if (label === "DROP") return (
      <svg width="32" height="22" viewBox="0 0 32 22" style={dropFx}>
        <line x1="16" y1="2" x2="16" y2="12" {...sp} strokeWidth="2.2"/>
        <polyline points="11,8 16,13 21,8" {...sp} strokeWidth="2.2"/>
        <line x1="8" y1="18" x2="24" y2="18" {...sp} strokeWidth="2.2"/>
      </svg>
    );
    if (label === "RETRY") return (
      <span style={{ fontSize: 24, lineHeight: 1, pointerEvents: "none", filter: `drop-shadow(0 0 ${pressed ? 7 : 3}px ${color})`, color: c }}>↺</span>
    );
    return <span style={{ fontSize: 24, pointerEvents:"none", filter:`drop-shadow(0 0 4px ${color})`, color:c }}>{label}</span>;
  })();

  const glow = pressed
    ? `0 0 28px ${color}bb, 0 0 10px ${color}66, inset 0 0 16px ${color}18`
    : `0 0 12px ${color}30, 0 2px 4px rgba(0,0,0,0.5), inset 0 0 8px ${color}08`;

  return (
    <button
      onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd} onTouchCancel={handleTouchCancel} onClick={onPress}
      style={{
        width: w, height: h, position: "relative", background: "transparent", border: "none",
        padding: 0, cursor: "pointer", WebkitTapHighlightColor: "transparent",
        outline: "none", userSelect: "none", WebkitUserSelect: "none", flexShrink: 0,
        transform: pressed ? "scale(0.91) translateY(1px)" : "scale(1)",
        transition: "transform 0.06s",
      }}
    >
      {/* Clipped body */}
      <div style={{
        position: "absolute", inset: 0,
        clipPath: `polygon(${cut}px 0%,100% 0%,100% calc(100% - ${cut}px),calc(100% - ${cut}px) 100%,0% 100%,0% ${cut}px)`,
        background: pressed
          ? `linear-gradient(145deg,${color}38,${color}1c)`
          : `linear-gradient(145deg,${color}12,${color}06)`,
        border: `1.5px solid ${pressed ? color + "cc" : color + "42"}`,
        boxShadow: glow,
        transition: "background 0.06s, border-color 0.06s, box-shadow 0.06s",
      }}/>
      {/* Corner accents */}
      {([
        { top:0, left:0, borderTop:`1.5px solid ${color}`, borderLeft:`1.5px solid ${color}` },
        { top:0, right:0, borderTop:`1.5px solid ${color}`, borderRight:`1.5px solid ${color}` },
        { bottom:0, left:0, borderBottom:`1.5px solid ${color}`, borderLeft:`1.5px solid ${color}` },
        { bottom:0, right:0, borderBottom:`1.5px solid ${color}`, borderRight:`1.5px solid ${color}` },
      ] as React.CSSProperties[]).map((s, i) => (
        <div key={i} style={{ position:"absolute", width:8, height:8, pointerEvents:"none", ...s, opacity: pressed ? 1 : 0.65, transition:"opacity 0.06s" }}/>
      ))}
      {/* Icon + label */}
      <div style={{ position:"absolute", inset:0, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap: wide ? 3 : 0, pointerEvents:"none" }}>
        {iconEl}
        {wide && (
          <span style={{
            fontFamily: '"Orbitron",monospace', fontWeight: 900, fontSize: 8,
            letterSpacing: "0.45em", color: c,
            textShadow: pressed ? `0 0 12px ${color},0 0 4px #ffffff88` : `0 0 8px ${color}66`,
            lineHeight: 1,
          }}>{label}</span>
        )}
      </div>
    </button>
  );
}

// ─── Ghost boards (other players' boards shown faded in background) ───────────
function GhostBoard({ board, cs }: { board: (string | 0)[][]; cs: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const COLS = 10, ROWS = 20;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = board[r]?.[c];
        if (cell) {
          ctx.fillStyle = cell as string;
          ctx.fillRect(c * cs, r * cs, cs - 0.5, cs - 0.5);
        }
      }
    }
  });
  return <canvas ref={ref} width={COLS * cs} height={ROWS * cs} style={{ display: 'block' }} />;
}

function GhostBoards({ boards }: { boards: (string | 0)[][][] }) {
  if (boards.length === 0) return null;
  const N = boards.length;
  const cs = N <= 2 ? 8 : N <= 5 ? 7 : N <= 10 ? 5 : N <= 20 ? 4 : 3;
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 1,
      display: 'flex', flexWrap: 'wrap', alignContent: 'center', justifyContent: 'center',
      gap: Math.max(2, cs),
      padding: 12,
      opacity: 0.14,
      pointerEvents: 'none',
    }}>
      {boards.map((board, i) => (
        <GhostBoard key={i} board={board} cs={cs} />
      ))}
    </div>
  );
}

// ─── Multiplayer screens ──────────────────────────────────────────────────────
const MULTI_BG: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: 9998,
  background: 'linear-gradient(180deg, #000812 0%, #000508 100%)',
  display: 'flex', flexDirection: 'column', alignItems: 'center',
  overflow: 'hidden', userSelect: 'none',
  fontFamily: '"Orbitron", monospace',
};

function CpBtn({ label, onClick, color = '#00f0f0', small }: { label: string; onClick: () => void; color?: string; small?: boolean }) {
  const [hov, setHov] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        padding: small ? '6px 16px' : '9px 22px',
        background: hov ? `${color}18` : 'transparent',
        border: `1px solid ${hov ? color : color + '66'}`,
        borderRadius: 5,
        color: hov ? color : `${color}cc`,
        fontFamily: '"Orbitron", monospace',
        fontWeight: 700,
        fontSize: small ? 9 : 10,
        letterSpacing: '0.3em',
        cursor: 'pointer',
        outline: 'none',
        transition: 'all 0.12s',
        whiteSpace: 'nowrap',
      }}
    >{label}</button>
  );
}

function MultiplayerLobby({
  rooms, onBack, onCreate, onJoin, onRefresh,
}: {
  rooms: RoomListItem[];
  onBack: () => void;
  onCreate: () => void;
  onJoin: (roomId: string, passkey: string) => void;
  onRefresh: () => void;
}) {
  const [joinTarget, setJoinTarget] = useState<RoomListItem | null>(null);
  const [passInput, setPassInput] = useState('');
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t); }, []);

  function handleJoin(room: RoomListItem) {
    if (room.status !== 'waiting') return;
    if (room.hasPasskey) {
      setJoinTarget(room);
      setPassInput('');
    } else {
      onJoin(room.id, '');
    }
  }

  return (
    <div style={{ ...MULTI_BG, overflow: 'auto', opacity: visible ? 1 : 0, transition: 'opacity 0.4s ease' }}>
      <style>{`
        @keyframes mpScan { 0%{transform:translateY(0)} 100%{transform:translateY(100vh)} }
      `}</style>
      <div style={{ position:'absolute',top:0,left:0,right:0,height:'3px',background:'linear-gradient(transparent,rgba(0,240,240,0.3),transparent)',animation:'mpScan 5s linear infinite',pointerEvents:'none' }} />

      {/* Header */}
      <div style={{ width:'100%', maxWidth:640, padding:'clamp(16px,5vw,48px) 16px 0', display:'flex', flexDirection:'column', gap:0 }}>
        <div style={{ fontSize:9, letterSpacing:'0.5em', color:'rgba(0,240,240,0.3)', marginBottom:6 }}>LANC PROJECT</div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', flexWrap:'wrap', gap:8, marginBottom:4 }}>
          <div style={{ fontSize:'clamp(16px,4vw,28px)', fontWeight:900, color:'#00f0f0', letterSpacing:'0.12em', textShadow:'0 0 20px rgba(0,240,240,0.7)' }}>MULTIPLAYER</div>
          <div style={{ display:'flex', gap:8, flexShrink:0 }}>
            <CpBtn label="↻ REFRESH" onClick={onRefresh} small />
            <CpBtn label="◀ BACK" onClick={onBack} small />
          </div>
        </div>
        <div style={{ height:1, background:'linear-gradient(90deg,rgba(0,240,240,0.5),rgba(0,240,240,0.1),transparent)', marginBottom:20 }} />
        <CpBtn label="＋ CREATE ROOM" onClick={onCreate} color="#a000f0" />
      </div>

      {/* Room list */}
      <div style={{ width:'100%', maxWidth:640, padding:'16px 16px 32px', overflowY:'auto', flex:1 }}>
        {rooms.length === 0 ? (
          <div style={{ color:'rgba(0,240,240,0.25)', fontSize:11, letterSpacing:'0.3em', textAlign:'center', marginTop:48 }}>NO ROOMS — CREATE ONE!</div>
        ) : (
          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {rooms.map(room => (
              <div key={room.id} style={{
                background:'linear-gradient(135deg,#060e20,#0a1830)',
                border:'1px solid rgba(0,240,240,0.14)',
                borderRadius:8,
                padding:'12px 16px',
                display:'flex', alignItems:'center', justifyContent:'space-between', gap:10,
              }}>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:3 }}>
                    {room.hasPasskey && (
                      <span style={{ fontSize:8, color:'#f0a000', border:'1px solid #f0a00055', borderRadius:3, padding:'1px 5px', letterSpacing:'0.2em' }}>🔒</span>
                    )}
                    <span style={{ color:'#fff', fontSize:12, fontWeight:700, letterSpacing:'0.06em', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{room.name}</span>
                  </div>
                  <div style={{ display:'flex', gap:10 }}>
                    <span style={{ fontSize:8, color:'rgba(0,240,240,0.5)', letterSpacing:'0.2em' }}>{room.playerCount}/{room.maxPlayers} PLAYERS</span>
                    <span style={{ fontSize:8, letterSpacing:'0.2em', color: room.status === 'waiting' ? '#00f060' : '#f04040' }}>{room.status.toUpperCase()}</span>
                  </div>
                </div>
                {room.status === 'waiting' && room.playerCount < room.maxPlayers && (
                  <CpBtn label="JOIN" onClick={() => handleJoin(room)} small />
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Passkey modal */}
      {joinTarget && (
        <div style={{ position:'fixed', inset:0, zIndex:10000, background:'rgba(0,0,0,0.8)', display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ background:'linear-gradient(135deg,#060e20,#0a1830)', border:'1px solid rgba(0,240,240,0.25)', borderRadius:12, padding:'28px 32px', display:'flex', flexDirection:'column', gap:14, minWidth:280 }}>
            <div style={{ fontSize:11, color:'#00f0f0', letterSpacing:'0.3em', fontWeight:700 }}>ENTER PASSKEY</div>
            <div style={{ fontSize:10, color:'rgba(255,255,255,0.5)', letterSpacing:'0.2em' }}>{joinTarget.name}</div>
            <input
              type="text"
              value={passInput}
              onChange={e => setPassInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { onJoin(joinTarget.id, passInput); setJoinTarget(null); } if (e.key === 'Escape') setJoinTarget(null); }}
              autoFocus
              placeholder="PASSKEY"
              style={{ background:'rgba(0,240,240,0.06)', border:'1px solid rgba(0,240,240,0.3)', borderRadius:5, padding:'8px 12px', color:'#00f0f0', fontFamily:'"Orbitron",monospace', fontSize:12, letterSpacing:'0.2em', outline:'none' }}
            />
            <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
              <CpBtn label="CANCEL" onClick={() => setJoinTarget(null)} small color="#f04040" />
              <CpBtn label="JOIN" onClick={() => { onJoin(joinTarget.id, passInput); setJoinTarget(null); }} small />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RoomCreateScreen({ onBack, onCreate }: {
  onBack: () => void;
  onCreate: (name: string, maxPlayers: number, passkey: string) => void;
}) {
  const [name, setName] = useState('');
  const [maxPlayers, setMaxPlayers] = useState(10);
  const [passkey, setPasskey] = useState('');
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t); }, []);

  const inputStyle: React.CSSProperties = {
    background: 'rgba(0,240,240,0.06)',
    border: '1px solid rgba(0,240,240,0.3)',
    borderRadius: 5,
    padding: '9px 14px',
    color: '#00f0f0',
    fontFamily: '"Orbitron", monospace',
    fontSize: 12,
    letterSpacing: '0.15em',
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  };
  const labelStyle: React.CSSProperties = {
    fontSize: 8, color: 'rgba(0,240,240,0.5)', letterSpacing: '0.35em', marginBottom: 5,
  };

  return (
    <div style={{ ...MULTI_BG, opacity: visible ? 1 : 0, transition: 'opacity 0.4s ease', alignItems:'center', justifyContent:'center' }}>
      <div style={{ width:'100%', maxWidth:400, padding:'0 24px' }}>
        <div style={{ fontSize:9, letterSpacing:'0.5em', color:'rgba(0,240,240,0.3)', marginBottom:6 }}>LANC PROJECT</div>
        <div style={{ fontSize:'clamp(16px,3.5vw,24px)', fontWeight:900, color:'#a000f0', letterSpacing:'0.12em', textShadow:'0 0 20px rgba(160,0,240,0.7)', marginBottom:4 }}>CREATE ROOM</div>
        <div style={{ height:1, background:'linear-gradient(90deg,rgba(160,0,240,0.5),transparent)', marginBottom:28 }} />

        <div style={{ display:'flex', flexDirection:'column', gap:18 }}>
          <div>
            <div style={labelStyle}>ROOM NAME</div>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="MY ROOM" maxLength={24} style={inputStyle} />
          </div>
          <div>
            <div style={labelStyle}>MAX PLAYERS: {maxPlayers}</div>
            <input type="range" min={2} max={100} value={maxPlayers} onChange={e => setMaxPlayers(Number(e.target.value))} style={{ width:'100%', accentColor:'#a000f0' }} />
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:7, color:'rgba(160,0,240,0.4)', letterSpacing:'0.2em', marginTop:2 }}>
              <span>2</span><span>100</span>
            </div>
          </div>
          <div>
            <div style={labelStyle}>PASSKEY (OPTIONAL)</div>
            <input type="text" value={passkey} onChange={e => setPasskey(e.target.value)} placeholder="LEAVE BLANK FOR PUBLIC" maxLength={20} style={inputStyle} />
          </div>
        </div>

        <div style={{ display:'flex', gap:10, marginTop:32, justifyContent:'flex-end' }}>
          <CpBtn label="◀ BACK" onClick={onBack} color="#f04040" />
          <CpBtn label="CREATE ▶" onClick={() => onCreate(name, maxPlayers, passkey)} color="#a000f0" />
        </div>
      </div>
    </div>
  );
}

function RoomWaitScreen({ room, myId, onBack, onStart }: {
  room: RoomPublic;
  myId: string;
  onBack: () => void;
  onStart: () => void;
}) {
  const isOwner = room.ownerId === myId;
  const [visible, setVisible] = useState(false);
  useEffect(() => { const t = setTimeout(() => setVisible(true), 60); return () => clearTimeout(t); }, []);

  return (
    <div style={{ ...MULTI_BG, overflow: 'auto', opacity: visible ? 1 : 0, transition: 'opacity 0.4s ease' }}>
      <style>{`
        @keyframes rwPulse { 0%,100%{opacity:0.5} 50%{opacity:1} }
      `}</style>

      <div style={{ width:'100%', maxWidth:520, padding:'clamp(16px,5vw,48px) 16px 0', display:'flex', flexDirection:'column', gap:0 }}>
        <div style={{ fontSize:9, letterSpacing:'0.5em', color:'rgba(0,240,240,0.3)', marginBottom:6 }}>LANC PROJECT</div>
        <div style={{ fontSize:'clamp(15px,3.5vw,22px)', fontWeight:900, color:'#00f0f0', letterSpacing:'0.1em', textShadow:'0 0 20px rgba(0,240,240,0.6)', marginBottom:2 }}>{room.name}</div>
        <div style={{ display:'flex', gap:12, marginBottom:4 }}>
          {room.hasPasskey && <span style={{ fontSize:8, color:'#f0a000', letterSpacing:'0.2em' }}>🔒 PRIVATE</span>}
          <span style={{ fontSize:8, color:'rgba(0,240,240,0.4)', letterSpacing:'0.2em' }}>MAX {room.maxPlayers}</span>
        </div>
        <div style={{ height:1, background:'linear-gradient(90deg,rgba(0,240,240,0.5),transparent)', marginBottom:20 }} />

        {/* Player list */}
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:8, color:'rgba(0,240,240,0.35)', letterSpacing:'0.35em', marginBottom:10 }}>PLAYERS ({room.players.length}/{room.maxPlayers})</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {room.players.map(p => (
              <div key={p.id} style={{
                display:'flex', alignItems:'center', gap:10,
                padding:'8px 14px',
                background: p.id === myId ? 'rgba(0,240,240,0.07)' : 'rgba(255,255,255,0.03)',
                border: p.id === myId ? '1px solid rgba(0,240,240,0.25)' : '1px solid rgba(255,255,255,0.06)',
                borderRadius:6,
              }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background: p.id === room.ownerId ? '#f0a000' : '#00f0f0', boxShadow: p.id === room.ownerId ? '0 0 8px #f0a000' : '0 0 8px #00f0f0' }} />
                <span style={{ color: p.id === myId ? '#00f0f0' : 'rgba(255,255,255,0.7)', fontSize:10, letterSpacing:'0.15em', fontWeight: p.id === myId ? 700 : 400 }}>
                  {p.name}{p.id === myId ? ' (YOU)' : ''}{p.id === room.ownerId ? ' ★' : ''}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Status / waiting */}
        {!isOwner && (
          <div style={{ fontSize:9, color:'rgba(0,240,240,0.4)', letterSpacing:'0.3em', animation:'rwPulse 2s ease-in-out infinite', textAlign:'center', marginBottom:20 }}>
            WAITING FOR HOST TO START...
          </div>
        )}

        {/* Actions */}
        <div style={{ display:'flex', gap:10, justifyContent: isOwner ? 'space-between' : 'flex-end' }}>
          <CpBtn label="◀ LEAVE" onClick={onBack} color="#f04040" />
          {isOwner && room.players.length >= 1 && (
            <CpBtn label="▶ START GAME" onClick={onStart} color="#00f060" />
          )}
        </div>
      </div>
    </div>
  );
}
