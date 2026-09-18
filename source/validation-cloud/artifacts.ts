import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export async function statValidationArtifact(path: string): Promise<{ sizeBytes: number; sha256: string }> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`artifact is not a regular file: ${path}`);
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return { sizeBytes: metadata.size, sha256: hash.digest("hex") };
}

