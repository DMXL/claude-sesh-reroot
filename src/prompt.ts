import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Ask a yes/no question on the terminal. Defaults to `false` on empty input. */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
