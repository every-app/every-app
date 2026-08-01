import type { LocalContext } from "@/context";
import chalk from "chalk";
import { ensureGeneratedWranglerConfig } from "@/lib/generateWranglerConfig";

interface GenerateConfigFlags {
  verbose?: boolean;
}

export async function generateConfig(
  this: LocalContext,
  flags: GenerateConfigFlags,
): Promise<void> {
  const cwd = process.cwd();
  const { manifest, configPath } = await ensureGeneratedWranglerConfig(cwd);

  if (flags.verbose) {
    console.log(
      chalk.dim(
        `Generated ${configPath} from everyapp.config.ts for ${manifest.id}.`,
      ),
    );
  }
}
