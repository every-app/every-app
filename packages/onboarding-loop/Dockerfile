# The sandbox image (design 4.3): Node 22, pnpm, git and the five harness
# binaries, nothing else. One container per run is created from it; the
# verifier's and the teardown's sibling containers come from the same image.
# The tag is a hash of this file (src/docker.ts imageTag), so a pin bump here
# is a new tag and shows in the report.
FROM node:22-bookworm

# /usr/sbin and /sbin are on PATH for everyone (runuser, useradd); the
# per-user installers below put their binaries in /home/dev/.local/bin.
ENV PATH="/home/dev/.local/bin:/home/dev/.opencode/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends git curl ca-certificates unzip procps build-essential \
  && rm -rf /var/lib/apt/lists/*

# pnpm from npm, not corepack: corepack's per-user cache is empty for `dev`.
# Claude Code and Codex are global as root so they are on PATH for everyone.
# OpenCode 2 is not on npm as `opencode-ai` (that name stops at 1.x): its v2
# installer pulls @opencode/cli-<platform>, so it is installed as dev below.
RUN npm i -g pnpm@10.34.5 @anthropic-ai/claude-code@2.1.309 @openai/codex@0.163.0

# `dev`: every harness runs as it (Claude Code refuses to skip permissions as
# root). /loop holds the prompt, the event log and the bundle; /work the clone.
RUN useradd -m -s /bin/bash dev \
  && mkdir -p /loop /work \
  && chown dev:dev /loop /work \
  && printf 'export PATH="/home/dev/.local/bin:/home/dev/.opencode/bin:$PATH"\n' > /etc/profile.d/loop.sh

USER dev
WORKDIR /home/dev

# The per-user installers, as dev, so their binaries land under /home/dev:
# OpenCode 2 (~/.opencode/bin/opencode), Cursor (~/.local/share/cursor-agent,
# ~/.local/bin/agent) and Hermes (~/.hermes, ~/.local/bin/hermes; pins its
# own uv and Python).
RUN curl -fsSL https://opencode.ai/v2/install | bash -s -- --version 2.1.3
RUN curl https://cursor.com/install -fsS | bash
RUN curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash -s -- --non-interactive --skip-browser --skip-computer-use

# Seeded consent, recorded as the deviation `claude_consent_seeded`: without
# it `claude -p --dangerously-skip-permissions` stops at a prompt no stream
# can answer. "No prior state" means no sessions, logins or caches, not an
# empty $HOME.
RUN mkdir -p /home/dev/.claude \
  && printf '{"skipDangerousModePermissionPrompt": true}\n' > /home/dev/.claude/settings.json \
  && printf '{"hasCompletedOnboarding": true}\n' > /home/dev/.claude.json

# The build fails here if one binary is missing, as dev, with the PATH above.
# One name per `command -v`: /bin/sh (dash) checks only the first of several.
RUN for b in pnpm claude codex opencode agent hermes; do command -v "$b" || exit 1; done

WORKDIR /work
CMD ["sleep", "infinity"]
