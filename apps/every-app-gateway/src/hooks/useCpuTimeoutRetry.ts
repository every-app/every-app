import { useState, useEffect, useCallback, useRef } from "react";

const MAX_RETRIES = 5;
const MIN_DELAY_MS = 20000;
const MAX_DELAY_MS = 60000;

function getRandomDelay() {
  return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

/**
 * Hook for handling requests that may fail due to Cloudflare CPU timeout.
 * Executes the request immediately, then retries with a random 20-60 second delay, up to 5 times.
 */
export function useCpuTimeoutRetry(retryFn: () => Promise<boolean>) {
  const [isRunning, setIsRunning] = useState(false);
  const [attemptCount, setAttemptCount] = useState(0);
  const [hasExhaustedRetries, setHasExhaustedRetries] = useState(false);
  const [secondsUntilRetry, setSecondsUntilRetry] = useState(0);

  const retryFnRef = useRef(retryFn);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const countdownRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );
  const attemptRef = useRef(0);
  const retryAtRef = useRef<number>(0);

  retryFnRef.current = retryFn;

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = undefined;
    }
  }, []);

  const startCountdown = useCallback(
    (delayMs: number) => {
      clearCountdown();
      retryAtRef.current = Date.now() + delayMs;
      setSecondsUntilRetry(Math.ceil(delayMs / 1000));

      countdownRef.current = setInterval(() => {
        const remaining = Math.max(
          0,
          Math.ceil((retryAtRef.current - Date.now()) / 1000),
        );
        setSecondsUntilRetry(remaining);
        if (remaining <= 0) {
          clearCountdown();
        }
      }, 1000);
    },
    [clearCountdown],
  );

  const attemptRequest = useCallback(async () => {
    setAttemptCount(attemptRef.current);
    setSecondsUntilRetry(0);

    const success = await retryFnRef.current();
    if (success) {
      setIsRunning(false);
      clearCountdown();
      return;
    }

    attemptRef.current += 1;
    setAttemptCount(attemptRef.current);

    if (attemptRef.current > MAX_RETRIES) {
      setIsRunning(false);
      setHasExhaustedRetries(true);
      clearCountdown();
      return;
    }

    const delay = getRandomDelay();
    startCountdown(delay);
    timeoutRef.current = setTimeout(attemptRequest, delay);
  }, [clearCountdown, startCountdown]);

  const executeWithRetry = useCallback(() => {
    attemptRef.current = 0;
    setAttemptCount(0);
    setSecondsUntilRetry(0);
    setIsRunning(true);
    setHasExhaustedRetries(false);
    attemptRequest();
  }, [attemptRequest]);

  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      clearCountdown();
    };
  }, [clearCountdown]);

  return {
    isRunning,
    attemptCount,
    maxRetries: MAX_RETRIES,
    hasExhaustedRetries,
    secondsUntilRetry,
    showWarning: (isRunning && attemptCount > 0) || hasExhaustedRetries,
    executeWithRetry,
  };
}
