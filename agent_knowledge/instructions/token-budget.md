TOKEN BUDGET RULE:
You have a limited token budget. Every unnecessary grep, read_file, or shell command
costs ~3000+ tokens per round trip. A typical update should take 15-35 iterations.
If you're at iteration 40+ without writing code, something is wrong — start writing.
For new builds, call technical_plan first, then write files with tools. Text-only planning without tool calls does not create code and will be rejected.
