// Downloads the voice models into resources/voice/, which is out of version
// control: they are hundreds of megabytes of binaries. Used both to set up a
// working copy and by the release workflow, so a build never depends on
// whatever happened to be on the machine.
//
//   node scripts/fetch-models.mjs
//
// Already-present files are verified and left alone, so re-running it is cheap
// and it doubles as a check that a working copy has what it needs.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "resources", "voice");

// The digests are of the copies this project was developed and verified
// against, not of whatever the URL serves today. A mismatch means the upstream
// file changed and the pipeline has to be re-checked, not that the download
// failed.
const MODELS = [
  {
    name: "silero_vad.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx",
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
    verify: "silero_vad.onnx",
  },
  {
    name: "denoiser-dpdfnet8.onnx",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/speech-enhancement-models/dpdfnet8.onnx",
    sha256: "2751c1f5a4e849d23a07c675b4c838158b249b42152f10cc318522dd339134f0",
    verify: "denoiser-dpdfnet8.onnx",
  },
  {
    name: "whisper-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    verify: "whisper-small.bin",
  },
  {
    name: "vits-piper-es_AR-daniela-high",
    url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-es_AR-daniela-high.tar.bz2",
    archive: true,
    // The archive itself carries no published digest, so the check lands on the
    // extracted weights instead.
    sha256: "a9606e518795605fedc1d424154ddde1550eeee9df97786cb3efba3dabe971e7",
    verify: "vits-piper-es_AR-daniela-high/es_AR-daniela-high.onnx",
  },
];

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function present(model) {
  const file = path.join(target, model.verify);
  try {
    await stat(file);
  } catch {
    return false;
  }
  const digest = await sha256(file);
  if (digest === model.sha256) return true;
  throw new Error(
    `${model.verify} is already there but its digest does not match\n` +
      `  expected ${model.sha256}\n  found    ${digest}\n` +
      "Delete it and run this again to fetch a clean copy.",
  );
}

async function download(url, file) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}

async function fetchModel(model) {
  if (await present(model)) {
    console.log(`· ${model.name} already there`);
    return;
  }

  console.log(`↓ ${model.name}`);
  // Staged inside the target directory rather than the system temp: a download
  // is only moved into place once it is complete, and on Windows the runner's
  // temp lives on C: while the checkout is on D:, where a rename across the two
  // fails with EXDEV.
  const work = await mkdtemp(path.join(target, ".fetching-"));
  try {
    if (model.archive) {
      const archive = path.join(work, "model.tar.bz2");
      await download(model.url, archive);
      // tar is present on all three runners and on any developer machine that
      // can build this project; bundling a decompressor would be heavier than
      // the dependency it avoids.
      execFileSync("tar", ["xf", archive, "-C", target], { stdio: "inherit" });
    } else {
      const staged = path.join(work, model.name);
      await download(model.url, staged);
      await rename(staged, path.join(target, model.name));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }

  const digest = await sha256(path.join(target, model.verify));
  if (digest !== model.sha256) {
    throw new Error(
      `${model.name} downloaded but its digest does not match\n` +
        `  expected ${model.sha256}\n  found    ${digest}\n` +
        "The upstream file changed; the pipeline has to be re-checked before trusting it.",
    );
  }
}

await mkdir(target, { recursive: true });
for (const model of MODELS) await fetchModel(model);
console.log(`\nModels ready in ${path.relative(root, target)}`);
