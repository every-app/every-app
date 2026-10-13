/**
 * Every App v2 manifest for Workout Tracker.
 *
 * Workout Tracker stays private by default and uses only its D1 and KV
 * resources.
 */
export default {
  id: "workout-tracker",
  name: "Workout Tracker",
  description: "Create custom programs and track your workouts",
  resources: {
    d1: ["DB"],
    kv: ["KV"],
  },
  public: [],
} as const;
