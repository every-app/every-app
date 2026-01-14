import { useState, useEffect, useCallback, useRef } from "react";

type Position = { x: number; y: number };
type Direction = "up" | "down" | "left" | "right";

const GRID_SIZE = 14;
const CELL_SIZE = 18;
const INITIAL_SPEED = 150;
const SPEED_INCREMENT = 5;
const MIN_SPEED = 60;

function getRandomPosition(exclude: Position[]): Position {
  let pos: Position;
  do {
    pos = {
      x: Math.floor(Math.random() * GRID_SIZE),
      y: Math.floor(Math.random() * GRID_SIZE),
    };
  } while (exclude.some((p) => p.x === pos.x && p.y === pos.y));
  return pos;
}

function positionsEqual(a: Position, b: Position): boolean {
  return a.x === b.x && a.y === b.y;
}

export function GameSnake() {
  const [snake, setSnake] = useState<Position[]>([
    { x: 7, y: 7 },
    { x: 6, y: 7 },
    { x: 5, y: 7 },
  ]);
  const [food, setFood] = useState<Position>(() =>
    getRandomPosition([
      { x: 7, y: 7 },
      { x: 6, y: 7 },
      { x: 5, y: 7 },
    ]),
  );
  const [direction, setDirection] = useState<Direction>("right");
  const [gameOver, setGameOver] = useState(false);
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(() => {
    if (typeof window !== "undefined") {
      return parseInt(localStorage.getItem("bestSnake") || "0", 10);
    }
    return 0;
  });
  const [hasStarted, setHasStarted] = useState(false);
  const [speed, setSpeed] = useState(INITIAL_SPEED);

  const directionRef = useRef(direction);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  // Update direction ref when direction changes
  useEffect(() => {
    directionRef.current = direction;
  }, [direction]);

  const resetGame = useCallback(() => {
    const initialSnake = [
      { x: 7, y: 7 },
      { x: 6, y: 7 },
      { x: 5, y: 7 },
    ];
    setSnake(initialSnake);
    setFood(getRandomPosition(initialSnake));
    setDirection("right");
    directionRef.current = "right";
    setGameOver(false);
    setScore(0);
    setSpeed(INITIAL_SPEED);
    setHasStarted(true);
  }, []);

  const startGame = useCallback(() => {
    setHasStarted(true);
  }, []);

  const changeDirection = useCallback((newDir: Direction) => {
    const current = directionRef.current;
    // Prevent reversing direction
    if (
      (current === "up" && newDir === "down") ||
      (current === "down" && newDir === "up") ||
      (current === "left" && newDir === "right") ||
      (current === "right" && newDir === "left")
    ) {
      return;
    }
    setDirection(newDir);
  }, []);

  // Game loop
  useEffect(() => {
    if (!hasStarted || gameOver) return;

    const moveSnake = () => {
      setSnake((currentSnake) => {
        const head = currentSnake[0];
        const dir = directionRef.current;

        let newHead: Position;
        switch (dir) {
          case "up":
            newHead = { x: head.x, y: head.y - 1 };
            break;
          case "down":
            newHead = { x: head.x, y: head.y + 1 };
            break;
          case "left":
            newHead = { x: head.x - 1, y: head.y };
            break;
          case "right":
            newHead = { x: head.x + 1, y: head.y };
            break;
        }

        // Check wall collision
        if (
          newHead.x < 0 ||
          newHead.x >= GRID_SIZE ||
          newHead.y < 0 ||
          newHead.y >= GRID_SIZE
        ) {
          setGameOver(true);
          return currentSnake;
        }

        // Check self collision (exclude tail since it will move)
        const bodyWithoutTail = currentSnake.slice(0, -1);
        if (
          bodyWithoutTail.some((segment) => positionsEqual(segment, newHead))
        ) {
          setGameOver(true);
          return currentSnake;
        }

        const newSnake = [newHead, ...currentSnake];

        // Check food collision
        if (positionsEqual(newHead, food)) {
          // Grow snake (don't remove tail)
          setScore((s) => {
            const newScore = s + 10;
            if (newScore > bestScore) {
              setBestScore(newScore);
              localStorage.setItem("bestSnake", newScore.toString());
            }
            return newScore;
          });
          setFood(getRandomPosition(newSnake));
          setSpeed((s) => Math.max(MIN_SPEED, s - SPEED_INCREMENT));
          return newSnake;
        }

        // Remove tail (snake moves forward)
        newSnake.pop();
        return newSnake;
      });
    };

    const interval = setInterval(moveSnake, speed);
    return () => clearInterval(interval);
  }, [hasStarted, gameOver, food, speed, bestScore]);

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const controlKeys = [
        "arrowup",
        "arrowdown",
        "arrowleft",
        "arrowright",
        " ",
        "enter",
        "h",
        "j",
        "k",
        "l",
        "w",
        "a",
        "s",
        "d",
      ];

      if (controlKeys.includes(key)) {
        e.preventDefault();
      }

      // Start game or restart after game over
      if (key === " " || key === "enter") {
        if (!hasStarted) {
          startGame();
        } else if (gameOver) {
          resetGame();
        }
        return;
      }

      if (!hasStarted || gameOver) return;

      switch (key) {
        case "arrowup":
        case "k":
        case "w":
          changeDirection("up");
          break;
        case "arrowdown":
        case "j":
        case "s":
          changeDirection("down");
          break;
        case "arrowleft":
        case "h":
        case "a":
          changeDirection("left");
          break;
        case "arrowright":
        case "l":
        case "d":
          changeDirection("right");
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [changeDirection, gameOver, hasStarted, resetGame, startGame]);

  // Touch controls
  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current || gameOver) return;

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const absDeltaX = Math.abs(deltaX);
    const absDeltaY = Math.abs(deltaY);

    // Require minimum swipe distance
    if (Math.max(absDeltaX, absDeltaY) < 30) {
      touchStartRef.current = null;
      return;
    }

    if (absDeltaX > absDeltaY) {
      changeDirection(deltaX > 0 ? "right" : "left");
    } else {
      changeDirection(deltaY > 0 ? "down" : "up");
    }

    touchStartRef.current = null;
  };

  const gridWidth = GRID_SIZE * CELL_SIZE;

  return (
    <div
      className="flex flex-col items-center gap-3 select-none flex-1 w-full touch-none"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Score display */}
      <div
        className="text-sm text-base-content/70 w-full text-right"
        style={{ maxWidth: gridWidth + 8 }}
      >
        Score: {score} • Best: {bestScore}
      </div>

      {/* Game board */}
      <div
        className="relative bg-base-300 rounded-lg p-1"
        style={{ width: gridWidth + 8, height: gridWidth + 8 }}
      >
        <div
          className="relative bg-base-100 rounded"
          style={{ width: gridWidth, height: gridWidth }}
        >
          {/* Snake */}
          {snake.map((segment, index) => (
            <div
              key={index}
              className={`absolute rounded-sm ${
                index === 0 ? "bg-success" : "bg-success/70"
              }`}
              style={{
                width: CELL_SIZE - 2,
                height: CELL_SIZE - 2,
                left: segment.x * CELL_SIZE + 1,
                top: segment.y * CELL_SIZE + 1,
              }}
            />
          ))}

          {/* Food */}
          <div
            className="absolute bg-error rounded-full"
            style={{
              width: CELL_SIZE - 4,
              height: CELL_SIZE - 4,
              left: food.x * CELL_SIZE + 2,
              top: food.y * CELL_SIZE + 2,
            }}
          />

          {/* Game over overlay */}
          {gameOver && (
            <div className="absolute inset-0 bg-base-100/90 rounded flex flex-col items-center justify-center">
              <div className="text-xl font-bold mb-2">Game Over!</div>
              <div className="text-sm mb-3">Score: {score}</div>
              <button className="btn btn-primary btn-sm" onClick={resetGame}>
                Play Again
              </button>
            </div>
          )}

          {/* Start overlay */}
          {!hasStarted && (
            <div className="absolute inset-0 bg-base-100/90 rounded flex flex-col items-center justify-center">
              <div className="text-xl font-bold mb-2">Snake</div>
              <div className="text-sm text-base-content/60 mb-3">
                A game to pass the time
              </div>
              <button className="btn btn-primary btn-sm" onClick={startGame}>
                Play
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Controls hint */}
      <div className="text-xs text-base-content/50 text-center">
        <span className="hidden sm:inline">Arrows to move</span>
        <span className="sm:hidden">Swipe to move</span>
        <span> • Visit /snake to play again later</span>
      </div>
    </div>
  );
}
