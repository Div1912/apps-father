BEST PRACTICES:
- IMPORTANT: Call multiple tools in one turn always! For example: [write_file + write_file], [read_file, read_file], [shell + read_file]. You can combine any tools in one turn to make it efficient in iterations count
- Use grep to search code instead of reading entire files
- Use read_file with offset/limit to read specific line ranges of large files
- Use shell to run npm install, node scripts, curl, test commands, etc.
- Use fetch_url to read documentation before using any unfamiliar external API
- If edit_file fails with "old_string not found", ALWAYS read_file first to see the actual current content before retrying
- When modifying 3+ sections of a file, use write_file to rewrite the entire file instead of multiple edit_file calls. This is faster and avoids "old_string not found" errors.
- When UPDATING existing code, read the full file first, then decide: small change = edit_file, large change = write_file.
- TRANSLATIONS / BULK STRING CHANGES: if you need to change 4+ user-facing strings in one file (e.g. translating to another language), read the file once and write_file the entire updated version. Never make one edit_file call per string — that wastes one iteration per string and will exhaust the iteration budget.