/**
 * Every question everyapp asks a person, so they all look and behave the
 * same (@inquirer/prompts underneath):
 *
 *  - Only a person at a terminal is asked: `canPromptInTerminal` (stdin
 *    and stderr are terminals; not under --json or CI). Prompts draw on
 *    stderr, so piping stdout (`| tee`) keeps them.
 *  - Context goes on dim lines above a short question (`context`).
 *  - The answer is echoed as a person reads it: a choice's label, never its
 *    id; Yes or No, never true/false. A confirmation shows `(y/N)` and
 *    defaults to No.
 *  - Ctrl-C at a prompt cancels: a `CancelledError`, which the run reports
 *    as a dim "Cancelled. Nothing changed." with no next step (exit 1).
 *    `confirmOrCancel` says the same when the answer is No.
 *
 * Each prompt stops the human sink's spinner first (handTerminalOver).
 */
import { confirm, input, password, select } from "@inquirer/prompts";
import chalk from "chalk";
import { CancelledError, EveryAppError } from "@/lib/errors";
import { handTerminalOver } from "./terminal";

/** Whether a person is at this terminal to answer prompts (everyapp's and cf's). */
export function canPromptInTerminal(json: boolean): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY) && !json && !process.env["CI"];
}

/** Asks the person at the terminal a yes/no question; tests answer for them. */
export type Confirm = (question: string, context?: readonly string[]) => Promise<boolean>;

interface Asked {
  /** Dim lines above the question: what the person needs to answer it. */
  context?: readonly string[];
}

const theme = {
  prefix: { idle: chalk.cyan("?"), done: chalk.green("✔") },
  style: {
    message: (text: string, status: string) =>
      status === "done" ? `${text} ${chalk.dim("·")}` : chalk.bold(text),
    answer: (text: string) => chalk.cyan(text),
    defaultAnswer: (text: string) => chalk.dim(`(${text})`),
    highlight: (text: string) => chalk.cyan(text),
    help: (text: string) => chalk.dim(text),
    error: (text: string) => chalk.red(`> ${text}`),
    description: (text: string) => chalk.dim(text),
    keysHelpTip: () => undefined,
  },
};

/** Run one prompt on stderr, its context above it; Ctrl-C is a cancel. */
async function ask<T>(
  { context = [] }: Asked,
  prompt: (context: { output: NodeJS.WritableStream }) => Promise<T>,
): Promise<T> {
  handTerminalOver();
  if (context.length > 0) {
    process.stderr.write(`${context.map((line) => chalk.dim(line)).join("\n")}\n`);
  }
  try {
    return await prompt({ output: process.stderr });
  } catch (error) {
    if (error instanceof Error && error.name === "ExitPromptError") throw new CancelledError();
    throw error;
  }
}

/** A yes/no question, No by default. */
export const confirmAtTerminal: Confirm = (question, context) =>
  ask({ context }, (streams) => confirm({ message: question, default: false, theme }, streams));

/**
 * Ask, and go on only on Yes: No raises a `CancelledError` saying
 * `cancelled` ("Cancelled. Nothing deleted.").
 */
export async function confirmOrCancel(
  asker: Confirm,
  question: string,
  { context, cancelled }: Asked & { cancelled?: string } = {},
): Promise<void> {
  if (!(await asker(question, context))) throw new CancelledError(cancelled);
}

/** One choice of a `choose` prompt: `label` is shown and echoed, `hint` dim beside it. */
interface Choice<T> {
  label: string;
  hint?: string;
  value: T;
}

/** Pick one of `choices`; the answer echoes the label. */
export function choose<T>(
  question: string,
  choices: ReadonlyArray<Choice<T>>,
  asked: Asked = {},
): Promise<T> {
  const width = Math.max(...choices.map((choice) => choice.label.length));
  return ask(asked, (streams) =>
    select(
      {
        message: question,
        choices: choices.map((choice) => ({
          name: choice.hint ? `${choice.label.padEnd(width)}  ${chalk.dim(choice.hint)}` : choice.label,
          short: choice.label,
          value: choice.value,
        })),
        theme,
      },
      streams,
    ),
  );
}

/** A line of text; `validate` returns why an answer won't do, or null. */
export function askText(
  question: string,
  options: Asked & { initial?: string; validate?: (value: string) => string | null } = {},
): Promise<string> {
  const { validate } = options;
  return ask(options, (streams) =>
    input(
      {
        message: question,
        ...(options.initial ? { default: options.initial } : {}),
        ...(validate ? { validate: (value: string) => validate(value) ?? true } : {}),
        theme,
      },
      streams,
    ),
  );
}

/**
 * A secret: typed invisibly (its length shows nowhere), answered as a fixed
 * mask. With `optional`, Enter on nothing is an answer too (echoed as
 * "skipped"): the caller leaves the setting as it is.
 */
export function askSecret(question: string, asked: Asked & { optional?: boolean } = {}): Promise<string> {
  // The prompt hands its answer style nothing (the value is never drawn),
  // so what was typed is kept from the validation, which runs just before.
  let typed = "";
  return ask(asked, (streams) =>
    password(
      {
        message: question,
        mask: false,
        toggleMask: false,
        validate: (value: string) => {
          typed = value;
          return value.trim() || asked.optional ? true : "Enter a value.";
        },
        theme: {
          ...theme,
          style: {
            ...theme.style,
            maskedText: "(hidden)",
            answer: () => (typed.trim() ? chalk.dim("••••••••") : chalk.dim("skipped")),
          },
        },
      },
      streams,
    ),
  );
}

/** A line for the person at the terminal, beside a prompt (on stderr, like prompts). */
export function tellPerson(text: string): void {
  handTerminalOver();
  process.stderr.write(`${text}\n`);
}

/**
 * Go on once a person agreed: `--yes` skips the question; with nobody at a
 * terminal it refuses with CONFIRMATION_REQUIRED (`unattended` says why;
 * its rerun adds --yes); No cancels.
 */
export async function confirmUnlessYes({
  yes,
  interactive,
  confirm = confirmAtTerminal,
  question,
  unattended,
  context,
  cancelled,
  data,
}: {
  yes?: boolean;
  interactive: boolean;
  confirm?: Confirm;
  question: string;
  unattended: string;
  context?: readonly string[];
  cancelled?: string;
  /** What the refusal's event carries for a script. */
  data?: Record<string, unknown>;
}): Promise<void> {
  if (yes) return;
  if (!interactive) {
    throw new EveryAppError("CONFIRMATION_REQUIRED", unattended, data ? { data } : {});
  }
  await confirmOrCancel(confirm, question, { context, cancelled });
}
