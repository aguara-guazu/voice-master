# Voice Master

**A terminal you talk to.** Every tab is a real shell; one of them runs an agent that
administers the rest — and answers you out loud, in Spanish.

You say *"open a session in the API project and have it fix the failing tests"*. It opens the
tab, hands the task over, watches it, and tells you when it is done. You never touched the
keyboard, and you were looking at something else.

## Install

Everything runs on your machine: speech recognition, the voice, the agent's tools. Nothing is
sent anywhere. The installers carry the models inside, so they are large (about 750 MB) and
there is nothing to download afterwards.

The applications are **not signed**, so each system asks for a confirmation the first time.

**macOS** (Apple Silicon — Intel Macs are not supported) — paste in a terminal:

```bash
curl -fL https://github.com/aguara-guazu/voice-master/releases/latest/download/Voice.Master-arm64.dmg -o /tmp/VoiceMaster.dmg && open /tmp/VoiceMaster.dmg
```

Drag **Voice Master** to Applications and open it. From then on it offers new versions on
launch and installs them itself.

**Windows** — paste in PowerShell:

```powershell
irm https://github.com/aguara-guazu/voice-master/releases/latest/download/Voice.Master-Setup-x64.exe -OutFile "$env:TEMP\VoiceMaster-Setup.exe"; & "$env:TEMP\VoiceMaster-Setup.exe"
```

No admin rights needed. SmartScreen will warn you the publisher is unknown: **More info →
Run anyway**.

**Linux** — paste in a terminal:

```bash
curl -fL https://github.com/aguara-guazu/voice-master/releases/latest/download/Voice.Master-x86_64.AppImage -o ~/VoiceMaster.AppImage && chmod +x ~/VoiceMaster.AppImage && ~/VoiceMaster.AppImage
```

That is the portable build, nothing to install. Debian and Ubuntu users can take
`Voice.Master-amd64.deb` from the
[releases page](https://github.com/aguara-guazu/voice-master/releases/latest) instead and
install it with `sudo apt install ./Voice.Master-amd64.deb`.

**You also need [Claude Code](https://claude.com/claude-code) on your PATH.** The application
starts `claude` in the master tab; without it, the tabs work but nobody administers them.

Only macOS on Apple Silicon has been used for real. Windows and Linux builds come off the same
pipeline but nobody has run them yet, and the shell integration that detects when a command
starts and ends is written for zsh.

## How it works

The first tab is the **master session**: an agent that never does the work itself. It opens
tabs, hands tasks to the agents inside them, watches their state and reports back. It reaches
them through an MCP server the application runs on loopback, and the address only goes to that
session, so nothing else on your machine gets those tools.

You talk to it. The microphone listens continuously, cuts what you said at the silences,
cleans it up and transcribes it locally; the text reaches the session as a message. It answers
in your terminal in full, and speaks a short version of the same thing.

While it speaks the microphone is closed, so it cannot hear itself — which also means you
cannot interrupt it by talking over it.

## Quick answers

**macOS says the app "is damaged".** That is what an unsigned application looks like when it
arrives through a browser or a chat. The install command above avoids it. If it already
happened:

```bash
xattr -dr com.apple.quarantine "/Applications/Voice Master.app"
```

**It does not hear me.** macOS asks for microphone permission the first time; if you dismissed
it, turn it back on in System Settings → Privacy & Security → Microphone.

**Does it send my voice anywhere?** No. Recognition (whisper) and the voice (Piper) run on your
machine, offline. The only thing that reaches the network is whatever Claude Code itself does.

**What language does it speak?** Spanish, with an Argentinian voice.

**How do updates work?** On macOS, it checks for a new release when it starts and asks before
doing anything. Accepting downloads the build and replaces the application, then restarts —
which is why the check happens at launch, before any tab is open: everything in this
application dies with the process, so there is nothing to lose at that moment and a lot to lose
later. Each update is a full build of around 680 MB, since the speech models are inside it. On
Windows and Linux it points at the releases page instead.

## Building it yourself

Requires Node 22 and, on Linux, the usual build tooling for native modules.

```bash
npm install          # compiles node-pty for Electron
npm run models       # downloads the ~616 MB of voice models, verified by digest
npm start            # compiles and runs
```

The models live in `resources/voice/` and are out of version control. `npm run models` is
re-runnable: it checks what is already there and only fetches what is missing.

Installers for the current platform:

```bash
npm run dist         # macOS
npm run dist:win     # Windows
npm run dist:linux   # Linux
```

They land in `release/`. Each one has to be built on its own platform **and architecture**:
`node-pty` is compiled from source and the speech libraries resolve a prebuilt binary per
platform, so cross-building would package native code for the wrong machine.

## Releases

Tagging is the whole procedure:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` builds macOS arm64, Windows x64 and Linux x64, each on its own
runner, downloads the models, and publishes every artifact to the release for that tag. macOS
on Intel and Windows/Linux on arm64 are not built.

## Licence

MIT. The bundled models carry their own: the `es_AR-daniela` voice comes from a
[CC BY-SA 4.0 dataset](https://www.openslr.org/61/), and the speech models come from
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) and
[whisper.cpp](https://github.com/ggerganov/whisper.cpp).
