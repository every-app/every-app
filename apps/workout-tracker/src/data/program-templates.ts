import type { DifficultyLevel } from "@/db/schema";

export interface ExerciseTemplate {
  name: string;
  sets: number;
  targetReps: number;
  weight?: number;
}

export interface WorkoutTemplate {
  name: string;
  description?: string;
  exercises: ExerciseTemplate[];
}

export interface ProgramTemplate {
  id: string;
  name: string;
  description: string;
  difficulty: DifficultyLevel;
  workouts: WorkoutTemplate[];
}

export const programTemplates: ProgramTemplate[] = [
  {
    id: "five-by-five",
    name: "5x5",
    description:
      "A beginner strength training program focusing on compound lifts with progressive overload",
    difficulty: "beginner",
    workouts: [
      {
        name: "Workout A",
        description: "Squat, Bench Press, Barbell Row",
        exercises: [
          { name: "Squat", sets: 5, targetReps: 5 },
          { name: "Bench Press", sets: 5, targetReps: 5 },
          { name: "Barbell Row", sets: 5, targetReps: 5 },
        ],
      },
      {
        name: "Workout B",
        description: "Squat, Overhead Press, Deadlift",
        exercises: [
          { name: "Squat", sets: 5, targetReps: 5 },
          { name: "Overhead Press", sets: 5, targetReps: 5 },
          { name: "Deadlift", sets: 1, targetReps: 5 },
        ],
      },
    ],
  },
  {
    id: "arms-torso-legs",
    name: "Arms-Torso-Legs 4-Day Split",
    description:
      "A 4-day split focusing on arms, torso push/pull, and legs for balanced development",
    difficulty: "intermediate",
    workouts: [
      {
        name: "Day 1: Arms & Shoulders",
        description: "Focus on shoulders, biceps, and triceps",
        exercises: [
          { name: "Standing Barbell OHP", sets: 4, targetReps: 8 },
          { name: "Dumbbell Lateral Raise", sets: 4, targetReps: 15 },
          { name: "Rear Delt Fly", sets: 3, targetReps: 15 },
          { name: "Barbell Curl", sets: 4, targetReps: 10 },
          { name: "Hammer Curl", sets: 3, targetReps: 12 },
          { name: "Tricep Pushdown", sets: 4, targetReps: 12 },
          { name: "Overhead Tricep Extension", sets: 3, targetReps: 12 },
        ],
      },
      {
        name: "Day 2: Torso (Push + Pull)",
        description: "Chest, back, and core movements",
        exercises: [
          { name: "Barbell Bench Press", sets: 4, targetReps: 8 },
          { name: "Pull-ups", sets: 4, targetReps: 8 },
          { name: "Incline Dumbbell Press", sets: 3, targetReps: 10 },
          { name: "Barbell Row", sets: 4, targetReps: 8 },
          { name: "Cable Fly", sets: 3, targetReps: 12 },
          { name: "Lat Pulldown", sets: 3, targetReps: 10 },
          { name: "Face Pull", sets: 3, targetReps: 15 },
        ],
      },
      {
        name: "Day 3: Legs",
        description: "Quads, hamstrings, glutes, and calves",
        exercises: [
          { name: "Barbell Squat", sets: 4, targetReps: 8 },
          { name: "Romanian Deadlift", sets: 4, targetReps: 10 },
          { name: "Leg Press", sets: 3, targetReps: 12 },
          { name: "Leg Curl", sets: 3, targetReps: 12 },
          { name: "Walking Lunges", sets: 3, targetReps: 12 },
          { name: "Calf Raise", sets: 4, targetReps: 15 },
        ],
      },
      {
        name: "Day 4: Full Body Power",
        description: "Compound movements for strength and power",
        exercises: [
          { name: "Deadlift", sets: 4, targetReps: 5 },
          { name: "Push Press", sets: 4, targetReps: 6 },
          { name: "Weighted Chin-ups", sets: 3, targetReps: 6 },
          { name: "Front Squat", sets: 3, targetReps: 8 },
          { name: "Dips", sets: 3, targetReps: 10 },
        ],
      },
    ],
  },
  {
    id: "upper-lower",
    name: "Upper/Lower Split",
    description:
      "A classic 4-day split alternating between upper and lower body workouts",
    difficulty: "intermediate",
    workouts: [
      {
        name: "Upper A (Strength)",
        description: "Heavy compound upper body lifts",
        exercises: [
          { name: "Barbell Bench Press", sets: 4, targetReps: 6 },
          { name: "Barbell Row", sets: 4, targetReps: 6 },
          { name: "Overhead Press", sets: 3, targetReps: 8 },
          { name: "Weighted Pull-ups", sets: 3, targetReps: 6 },
          { name: "Barbell Curl", sets: 3, targetReps: 10 },
          { name: "Skullcrusher", sets: 3, targetReps: 10 },
        ],
      },
      {
        name: "Lower A (Strength)",
        description: "Heavy compound lower body lifts",
        exercises: [
          { name: "Barbell Squat", sets: 4, targetReps: 6 },
          { name: "Romanian Deadlift", sets: 4, targetReps: 8 },
          { name: "Leg Press", sets: 3, targetReps: 10 },
          { name: "Leg Curl", sets: 3, targetReps: 10 },
          { name: "Standing Calf Raise", sets: 4, targetReps: 12 },
        ],
      },
      {
        name: "Upper B (Hypertrophy)",
        description: "Volume-focused upper body work",
        exercises: [
          { name: "Incline Dumbbell Press", sets: 4, targetReps: 10 },
          { name: "Cable Row", sets: 4, targetReps: 10 },
          { name: "Dumbbell Shoulder Press", sets: 3, targetReps: 12 },
          { name: "Lat Pulldown", sets: 3, targetReps: 12 },
          { name: "Lateral Raise", sets: 3, targetReps: 15 },
          { name: "Hammer Curl", sets: 3, targetReps: 12 },
          { name: "Tricep Pushdown", sets: 3, targetReps: 12 },
        ],
      },
      {
        name: "Lower B (Hypertrophy)",
        description: "Volume-focused lower body work",
        exercises: [
          { name: "Front Squat", sets: 4, targetReps: 10 },
          { name: "Conventional Deadlift", sets: 3, targetReps: 6 },
          { name: "Bulgarian Split Squat", sets: 3, targetReps: 10 },
          { name: "Glute Ham Raise", sets: 3, targetReps: 10 },
          { name: "Leg Extension", sets: 3, targetReps: 15 },
          { name: "Seated Calf Raise", sets: 4, targetReps: 15 },
        ],
      },
    ],
  },
  {
    id: "push-pull-legs",
    name: "Push/Pull/Legs",
    description:
      "An advanced 6-day program organizing workouts by movement pattern for maximum frequency",
    difficulty: "advanced",
    workouts: [
      {
        name: "Push A",
        description: "Chest, shoulders, triceps (strength focus)",
        exercises: [
          { name: "Barbell Bench Press", sets: 4, targetReps: 6 },
          { name: "Overhead Press", sets: 4, targetReps: 6 },
          { name: "Incline Dumbbell Press", sets: 3, targetReps: 10 },
          { name: "Dumbbell Lateral Raise", sets: 3, targetReps: 15 },
          { name: "Tricep Dips", sets: 3, targetReps: 10 },
          { name: "Overhead Tricep Extension", sets: 3, targetReps: 12 },
        ],
      },
      {
        name: "Pull A",
        description: "Back, biceps, rear delts (strength focus)",
        exercises: [
          { name: "Deadlift", sets: 3, targetReps: 5 },
          { name: "Weighted Pull-ups", sets: 4, targetReps: 6 },
          { name: "Barbell Row", sets: 4, targetReps: 6 },
          { name: "Face Pull", sets: 3, targetReps: 15 },
          { name: "Barbell Curl", sets: 3, targetReps: 10 },
          { name: "Hammer Curl", sets: 3, targetReps: 12 },
        ],
      },
      {
        name: "Legs A",
        description: "Quads, hamstrings, glutes, calves (strength focus)",
        exercises: [
          { name: "Barbell Squat", sets: 4, targetReps: 6 },
          { name: "Romanian Deadlift", sets: 4, targetReps: 8 },
          { name: "Leg Press", sets: 3, targetReps: 10 },
          { name: "Leg Curl", sets: 3, targetReps: 10 },
          { name: "Standing Calf Raise", sets: 4, targetReps: 12 },
        ],
      },
      {
        name: "Push B",
        description: "Chest, shoulders, triceps (hypertrophy focus)",
        exercises: [
          { name: "Incline Barbell Press", sets: 4, targetReps: 8 },
          { name: "Dumbbell Shoulder Press", sets: 4, targetReps: 10 },
          { name: "Cable Fly", sets: 3, targetReps: 12 },
          { name: "Lateral Raise", sets: 4, targetReps: 15 },
          { name: "Tricep Pushdown", sets: 3, targetReps: 12 },
          { name: "Close Grip Bench Press", sets: 3, targetReps: 10 },
        ],
      },
      {
        name: "Pull B",
        description: "Back, biceps, rear delts (hypertrophy focus)",
        exercises: [
          { name: "Chest Supported Row", sets: 4, targetReps: 10 },
          { name: "Lat Pulldown", sets: 4, targetReps: 10 },
          { name: "Cable Row", sets: 3, targetReps: 12 },
          { name: "Rear Delt Fly", sets: 3, targetReps: 15 },
          { name: "Incline Dumbbell Curl", sets: 3, targetReps: 12 },
          { name: "Preacher Curl", sets: 3, targetReps: 12 },
        ],
      },
      {
        name: "Legs B",
        description: "Quads, hamstrings, glutes, calves (hypertrophy focus)",
        exercises: [
          { name: "Front Squat", sets: 4, targetReps: 8 },
          { name: "Sumo Deadlift", sets: 4, targetReps: 8 },
          { name: "Bulgarian Split Squat", sets: 3, targetReps: 10 },
          { name: "Glute Ham Raise", sets: 3, targetReps: 10 },
          { name: "Leg Extension", sets: 3, targetReps: 15 },
          { name: "Seated Calf Raise", sets: 4, targetReps: 15 },
        ],
      },
    ],
  },
];
