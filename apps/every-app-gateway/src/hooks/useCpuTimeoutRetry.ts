import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const MAX_RETRIES = 10;
const MIN_DELAY_MS = 20000;
const MAX_DELAY_MS = 60000;

// Mock mode settings - shorter delays for testing
const MOCK_MIN_DELAY_MS = 5000;
const MOCK_MAX_DELAY_MS = 10000;

/**
 * Hook for handling requests that may fail due to Cloudflare CPU timeout.
 * Executes the request immediately, then retries with a random 20-60 second delay, up to 10 times.
 *
 * @param retryFn - Function that returns true to stop retrying, false to retry (CPU timeout)
 */
export function useCpuTimeoutRetry(retryFn: () => Promise<boolean>) {
  const [isRunning, setIsRunning] = useState(false);
  const [attemptCount, setAttemptCount] = useState(0);
  const [hasExhaustedRetries, setHasExhaustedRetries] = useState(false);
  const [secondsUntilRetry, setSecondsUntilRetry] = useState(0);
  const [isRetrySuccess, setIsRetrySuccess] = useState(false);

  const mockMode = useMemo(() => {
    if (typeof window === "undefined") return false;
    return (
      new URLSearchParams(window.location.search).get("mockCpuTimeout") ===
      "true"
    );
  }, []);

  const retryFnRef = useRef(retryFn);
  const attemptRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const countdownRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );

  retryFnRef.current = retryFn;

  // Whether at least one retry has been attempted (i.e., first attempt failed)
  const hadRetries = attemptRef.current >= 1;

  // Call from your success handler to show the success screen
  const setRetrySuccess = useCallback(() => {
    setIsRetrySuccess(true);
  }, []);

  const getRandomDelay = useCallback(() => {
    if (mockMode) {
      return (
        MOCK_MIN_DELAY_MS +
        Math.random() * (MOCK_MAX_DELAY_MS - MOCK_MIN_DELAY_MS)
      );
    }
    return MIN_DELAY_MS + Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS);
  }, [mockMode]);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = undefined;
    }
  }, []);

  const startCountdown = useCallback(
    (delayMs: number) => {
      clearCountdown();
      setSecondsUntilRetry(Math.ceil(delayMs / 1000));

      countdownRef.current = setInterval(() => {
        setSecondsUntilRetry((prev) => {
          const remaining = prev - 1;
          if (remaining <= 0) {
            clearCountdown();
          }
          return Math.max(0, remaining);
        });
      }, 1000);
    },
    [clearCountdown],
  );

  const attemptRequest = useCallback(async () => {
    setAttemptCount(attemptRef.current);
    setSecondsUntilRetry(0);

    // In mock mode, always simulate a CPU timeout failure
    const success = mockMode ? false : await retryFnRef.current();
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
  }, [clearCountdown, startCountdown, mockMode, getRandomDelay]);

  const executeWithRetry = useCallback(() => {
    attemptRef.current = 0;
    setAttemptCount(0);
    setSecondsUntilRetry(0);
    setIsRunning(true);
    setHasExhaustedRetries(false);
    setIsRetrySuccess(false);
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
    isRetrySuccess,
    showWarning: (isRunning && attemptCount > 0) || hasExhaustedRetries,
    hadRetries,
    setRetrySuccess,
    executeWithRetry,
  };
}
