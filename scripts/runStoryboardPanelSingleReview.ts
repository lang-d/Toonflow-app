process.env.TOONFLOW_READONLY_DB = "1";

function readIntegerArg(name: string) {
  const value = process.argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`Provide ${name}=<positive integer>`);
  return parsed;
}

async function writeStdout(value: string) {
  await new Promise<void>((resolve, reject) => {
    process.stdout.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

async function writeStderr(value: string) {
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

async function main() {
  const projectId = readIntegerArg("--projectId");
  const scriptId = readIntegerArg("--scriptId");
  const serviceModule = await import("@/services/storyboardPanelSingleReview");
  const runStoryboardPanelSingleReview =
    (serviceModule as any).runStoryboardPanelSingleReview ?? (serviceModule as any).default?.runStoryboardPanelSingleReview;
  if (typeof runStoryboardPanelSingleReview !== "function") {
    throw new Error("Unable to load runStoryboardPanelSingleReview from the CommonJS module wrapper.");
  }
  const startedAt = Date.now();
  const review = await runStoryboardPanelSingleReview({ projectId, scriptId });
  await writeStdout(
    JSON.stringify(
      {
        mode: "single_read_only_storyboard_panel_comparison",
        snapshotId: review.bundle.snapshotId,
        total: review.bundle.total,
        inputChars: JSON.stringify(review.bundle).length,
        outputChars: JSON.stringify(review.result).length,
        durationMs: Date.now() - startedAt,
        result: review.result,
      },
      null,
      2,
    ) + "\n",
  );
}

const keepProcessAlive = setInterval(() => undefined, 1_000);
main()
  .catch(async (error) => {
    await writeStderr(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => clearInterval(keepProcessAlive));
