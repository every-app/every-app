import { describe, it, expect } from "vitest";
import {
  roundToLoadableWeight,
  estimateE1RM,
  calculateWeightForReps,
  allSetsHitTarget,
  getExercisesToProgress,
  calculateLinearProgressionUpdates,
  calculateSmartProgressionUpdates,
  type SetLogData,
  type WorkoutExerciseData,
} from "./progression";

// ============================================================================
// Utility Functions
// ============================================================================

describe("roundToLoadableWeight", () => {
  it("rounds 157 down to 155", () => {
    expect(roundToLoadableWeight(157)).toBe(155);
  });

  it("rounds 158 up to 160", () => {
    expect(roundToLoadableWeight(158)).toBe(160);
  });

  it("rounds 157.5 up to 160 (midpoint rounds up)", () => {
    expect(roundToLoadableWeight(157.5)).toBe(160);
  });

  it("keeps 160 as 160 (already rounded)", () => {
    expect(roundToLoadableWeight(160)).toBe(160);
  });

  it("handles 0", () => {
    expect(roundToLoadableWeight(0)).toBe(0);
  });

  it("handles small weights", () => {
    expect(roundToLoadableWeight(7)).toBe(5);
    expect(roundToLoadableWeight(8)).toBe(10);
    expect(roundToLoadableWeight(2)).toBe(0);
    expect(roundToLoadableWeight(3)).toBe(5);
  });
});

describe("estimateE1RM", () => {
  it("calculates e1RM for 135x5 using Epley formula", () => {
    // e1RM = 135 × (1 + 5/30) = 135 × 1.167 = 157.5
    const result = estimateE1RM(135, 5);
    expect(result).toBeCloseTo(157.5, 1);
  });

  it("calculates e1RM for 200x10", () => {
    // e1RM = 200 × (1 + 10/30) = 200 × 1.333 = 266.67
    const result = estimateE1RM(200, 10);
    expect(result).toBeCloseTo(266.67, 1);
  });

  it("calculates e1RM for 315x1 (1RM equals the weight)", () => {
    // e1RM = 315 × (1 + 1/30) = 315 × 1.033 = 325.5
    const result = estimateE1RM(315, 1);
    expect(result).toBeCloseTo(325.5, 1);
  });

  it("returns 0 for 0 weight", () => {
    expect(estimateE1RM(0, 5)).toBe(0);
  });

  it("returns 0 for 0 reps", () => {
    expect(estimateE1RM(135, 0)).toBe(0);
  });
});

describe("calculateWeightForReps", () => {
  it("calculates weight for 5 reps given e1RM", () => {
    // If e1RM = 157.5, weight for 5 reps = 157.5 / 1.167 = 135
    const result = calculateWeightForReps(157.5, 5);
    expect(result).toBeCloseTo(135, 0);
  });

  it("calculates weight for 10 reps given e1RM", () => {
    // If e1RM = 200, weight for 10 reps = 200 / 1.333 = 150
    const result = calculateWeightForReps(200, 10);
    expect(result).toBeCloseTo(150, 0);
  });

  it("returns 0 for 0 e1RM", () => {
    expect(calculateWeightForReps(0, 5)).toBe(0);
  });

  it("returns 0 for 0 reps", () => {
    expect(calculateWeightForReps(200, 0)).toBe(0);
  });

  it("is the inverse of estimateE1RM", () => {
    const weight = 185;
    const reps = 8;
    const e1RM = estimateE1RM(weight, reps);
    const backToWeight = calculateWeightForReps(e1RM, reps);
    expect(backToWeight).toBeCloseTo(weight, 5);
  });
});

// ============================================================================
// Decision Logic
// ============================================================================

describe("allSetsHitTarget", () => {
  it("returns true when all sets hit target reps", () => {
    const setLogs: SetLogData[] = [
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
    ];
    expect(allSetsHitTarget(setLogs)).toBe(true);
  });

  it("returns true when sets exceed target reps", () => {
    const setLogs: SetLogData[] = [
      { exerciseId: "squat", targetReps: 5, actualReps: 6, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 7, weight: 135 },
    ];
    expect(allSetsHitTarget(setLogs)).toBe(true);
  });

  it("returns false when any set misses target", () => {
    const setLogs: SetLogData[] = [
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 4, weight: 135 }, // missed
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
    ];
    expect(allSetsHitTarget(setLogs)).toBe(false);
  });

  it("returns false for empty array", () => {
    expect(allSetsHitTarget([])).toBe(false);
  });
});

describe("getExercisesToProgress", () => {
  it("returns exercises where all sets hit target", () => {
    const setLogs: SetLogData[] = [
      // Squat - all 5 sets hit
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      // Bench - missed last set
      { exerciseId: "bench", targetReps: 5, actualReps: 5, weight: 95 },
      { exerciseId: "bench", targetReps: 5, actualReps: 5, weight: 95 },
      { exerciseId: "bench", targetReps: 5, actualReps: 4, weight: 95 },
    ];

    const result = getExercisesToProgress(setLogs);

    expect(result).toEqual(["squat"]);
    expect(result).not.toContain("bench");
  });

  it("returns multiple exercises when all hit target", () => {
    const setLogs: SetLogData[] = [
      { exerciseId: "squat", targetReps: 5, actualReps: 5, weight: 135 },
      { exerciseId: "bench", targetReps: 5, actualReps: 5, weight: 95 },
      { exerciseId: "row", targetReps: 5, actualReps: 5, weight: 95 },
    ];

    const result = getExercisesToProgress(setLogs);

    expect(result).toContain("squat");
    expect(result).toContain("bench");
    expect(result).toContain("row");
  });

  it("returns empty array when no exercises hit target", () => {
    const setLogs: SetLogData[] = [
      { exerciseId: "squat", targetReps: 5, actualReps: 4, weight: 135 },
      { exerciseId: "bench", targetReps: 5, actualReps: 3, weight: 95 },
    ];

    const result = getExercisesToProgress(setLogs);
    expect(result).toEqual([]);
  });
});

// ============================================================================
// Linear Progression
// ============================================================================

describe("calculateLinearProgressionUpdates", () => {
  describe("5x5 scenario - same exercise in multiple workouts", () => {
    it("applies same weight to both workouts when one completes", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        ["squat"],
        incrementMap,
      );

      expect(updates.length).toBe(2);
      expect(updates.find((u) => u.id === "we1")?.newWeight).toBe(140);
      expect(updates.find((u) => u.id === "we2")?.newWeight).toBe(140);
    });

    it("uses max weight across workouts when weights differ", () => {
      // Edge case: somehow weights got out of sync
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 140,
          workoutId: "workoutA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        ["squat"],
        incrementMap,
      );

      // Both should get 140 + 5 = 145
      expect(updates.find((u) => u.id === "we1")?.newWeight).toBe(145);
      expect(updates.find((u) => u.id === "we2")?.newWeight).toBe(145);
    });
  });

  describe("upper/lower scenario - same exercise, different rep ranges", () => {
    it("applies same weight regardless of rep range (linear ignores rep ranges)", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 6,
          weight: 165,
          workoutId: "lowerA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 10,
          weight: 150,
          workoutId: "lowerB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        ["squat"],
        incrementMap,
      );

      // Both get max(165, 150) + 5 = 170
      expect(updates.find((u) => u.id === "we1")?.newWeight).toBe(170);
      expect(updates.find((u) => u.id === "we2")?.newWeight).toBe(170);
    });
  });

  describe("increment handling", () => {
    it("uses exercise-specific increment (10 lbs for deadlift)", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "deadlift",
          targetReps: 5,
          weight: 225,
          workoutId: "workoutB",
        },
      ];

      const incrementMap = new Map([["deadlift", 10]]);

      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        ["deadlift"],
        incrementMap,
      );

      expect(updates[0].newWeight).toBe(235);
    });

    it("defaults to 5 lbs when increment not specified", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
      ];

      const incrementMap = new Map<string, number>(); // empty

      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        ["squat"],
        incrementMap,
      );

      expect(updates[0].newWeight).toBe(140);
    });
  });

  describe("filtering", () => {
    it("only updates exercises that should progress", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
        {
          id: "we2",
          exerciseId: "bench",
          targetReps: 5,
          weight: 95,
          workoutId: "workoutA",
        },
      ];

      const incrementMap = new Map([
        ["squat", 5],
        ["bench", 5],
      ]);

      // Only squat should progress
      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        ["squat"],
        incrementMap,
      );

      expect(updates.length).toBe(1);
      expect(updates[0].exerciseId).toBe("squat");
    });

    it("returns empty array when no exercises should progress", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
      ];

      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        [], // nothing to progress
        new Map(),
      );

      expect(updates).toEqual([]);
    });
  });

  describe("rounding", () => {
    it("rounds result to nearest 5 lbs", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 137, // odd weight
          workoutId: "workoutA",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateLinearProgressionUpdates(
        workoutExercises,
        ["squat"],
        incrementMap,
      );

      // 137 + 5 = 142 → rounds to 140
      expect(updates[0].newWeight).toBe(140);
    });
  });
});

// ============================================================================
// Smart Progression
// ============================================================================

describe("calculateSmartProgressionUpdates", () => {
  describe("5x5 scenario - same rep range", () => {
    it("both workouts get same weight (e1RM ratio is ~1 for same reps)", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateSmartProgressionUpdates(
        workoutExercises,
        ["squat"],
        "workoutA", // completed workout A
        incrementMap,
      );

      // Workout A: 135 + 5 = 140 (direct increment)
      // Workout B: 135 * ratio = 135 * (157.5/150) ≈ 142 → rounds to 140
      expect(updates.find((u) => u.id === "we1")?.newWeight).toBe(140);
      expect(updates.find((u) => u.id === "we2")?.newWeight).toBe(140);
    });
  });

  describe("upper/lower scenario - different rep ranges", () => {
    it("scales weights proportionally based on e1RM ratio", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 6,
          weight: 165,
          workoutId: "lowerA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 10,
          weight: 150,
          workoutId: "lowerB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateSmartProgressionUpdates(
        workoutExercises,
        ["squat"],
        "lowerA", // completed Lower A (6 reps)
        incrementMap,
      );

      // Lower A: 165 + 5 = 170 (direct increment)
      const lowerAUpdate = updates.find((u) => u.id === "we1");
      expect(lowerAUpdate?.newWeight).toBe(170);

      // Lower B calculation:
      // Old e1RM = 165 * (1 + 6/30) = 165 * 1.2 = 198
      // New e1RM = 170 * (1 + 6/30) = 170 * 1.2 = 204
      // Ratio = 204 / 198 = 1.0303
      // New weight = 150 * 1.0303 = 154.5 → rounds to 155
      const lowerBUpdate = updates.find((u) => u.id === "we2");
      expect(lowerBUpdate?.newWeight).toBe(155);
    });

    it("works when completing the higher-rep workout", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 6,
          weight: 165,
          workoutId: "lowerA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 10,
          weight: 150,
          workoutId: "lowerB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateSmartProgressionUpdates(
        workoutExercises,
        ["squat"],
        "lowerB", // completed Lower B (10 reps)
        incrementMap,
      );

      // Lower B: 150 + 5 = 155 (direct increment)
      const lowerBUpdate = updates.find((u) => u.id === "we2");
      expect(lowerBUpdate?.newWeight).toBe(155);

      // Lower A calculation:
      // Old e1RM = 150 * (1 + 10/30) = 150 * 1.333 = 200
      // New e1RM = 155 * (1 + 10/30) = 155 * 1.333 = 206.67
      // Ratio = 206.67 / 200 = 1.0333
      // New weight = 165 * 1.0333 = 170.5 → rounds to 170
      const lowerAUpdate = updates.find((u) => u.id === "we1");
      expect(lowerAUpdate?.newWeight).toBe(170);
    });
  });

  describe("edge cases", () => {
    it("skips exercise group when completed exercise has no weight", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: null, // no weight
          workoutId: "workoutA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateSmartProgressionUpdates(
        workoutExercises,
        ["squat"],
        "workoutA", // completed workout with null weight
        incrementMap,
      );

      expect(updates).toEqual([]);
    });

    it("skips individual exercise when it has no weight", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
        {
          id: "we2",
          exerciseId: "squat",
          targetReps: 5,
          weight: null, // no weight
          workoutId: "workoutB",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateSmartProgressionUpdates(
        workoutExercises,
        ["squat"],
        "workoutA",
        incrementMap,
      );

      // Only we1 should be updated
      expect(updates.length).toBe(1);
      expect(updates[0].id).toBe("we1");
    });

    it("handles when completed workout exercise not found", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
      ];

      const incrementMap = new Map([["squat", 5]]);

      const updates = calculateSmartProgressionUpdates(
        workoutExercises,
        ["squat"],
        "workoutC", // doesn't exist
        incrementMap,
      );

      expect(updates).toEqual([]);
    });
  });

  describe("multiple exercises", () => {
    it("handles multiple exercises independently", () => {
      const workoutExercises: WorkoutExerciseData[] = [
        {
          id: "we1",
          exerciseId: "squat",
          targetReps: 5,
          weight: 135,
          workoutId: "workoutA",
        },
        {
          id: "we2",
          exerciseId: "bench",
          targetReps: 5,
          weight: 95,
          workoutId: "workoutA",
        },
      ];

      const incrementMap = new Map([
        ["squat", 5],
        ["bench", 5],
      ]);

      const updates = calculateSmartProgressionUpdates(
        workoutExercises,
        ["squat", "bench"],
        "workoutA",
        incrementMap,
      );

      expect(updates.length).toBe(2);
      expect(updates.find((u) => u.exerciseId === "squat")?.newWeight).toBe(
        140,
      );
      expect(updates.find((u) => u.exerciseId === "bench")?.newWeight).toBe(
        100,
      );
    });
  });
});
