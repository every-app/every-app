// "Play a test sound" in onboarding: a short, soft two-note chime through the Mac's output, so the
// helper's self-test hears sound on the system side and system audio is verified (macOS can't
// report that grant otherwise; src/main/permissions.ts). Web Audio needs nothing the CSP refuses.

export function playTestTone(seconds = 1.4): void {
  const context = new AudioContext();
  const gain = context.createGain();
  gain.connect(context.destination);
  const start = context.currentTime;
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(0.18, start + 0.05);
  gain.gain.setValueAtTime(0.18, start + seconds - 0.25);
  gain.gain.linearRampToValueAtTime(0, start + seconds);
  for (const [frequency, at] of [
    [660, 0],
    [880, seconds / 2],
  ] as const) {
    const tone = context.createOscillator();
    tone.type = "sine";
    tone.frequency.value = frequency;
    tone.connect(gain);
    tone.start(start + at);
    tone.stop(start + (at === 0 ? seconds / 2 : seconds));
  }
  setTimeout(() => void context.close(), (seconds + 0.5) * 1000);
}
