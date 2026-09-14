---
description: Compress a large file or piped text into a distillate before reading it in full
allowed-tools: Bash, Read
argument-hint: <file-path> [--style=bullets|prose|outline] [--max-words=N] [--focus="topic"] [--local]
---

Compress the input:

1. Bash: `aos compress $ARGUMENTS` (fallback: `sh "${CLAUDE_PLUGIN_ROOT}/bin/aos" compress $ARGUMENTS`). Without `--local` it prints a `<<<AOS_CONTEXT feature=compress>>> … <<<END>>>` block with the chunked input and the requested style, word cap and focus. Write the distillate yourself in that style and print it.
2. With `--local` the provider produces the distillate; relay it verbatim.
3. If the script errors, read the file directly and summarize it yourself.
