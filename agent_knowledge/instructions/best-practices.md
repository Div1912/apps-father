BEST PRACTICES:
- IMPORTANT: Call multiple tools in one turn when it can make! For example: [write_file + check_todo], [read_file, read_file], [shell + read_file]. You can combine any tools in one turn to make it efficient in iterations count
- IMPORTANT: When using tools: write_file, edit_file, shell, deploy_to_dev — batch check_todo in the same turn whenever a checklist item is being completed. Do NOT call check_todo as a single tool call (it will be rejected).
- Use grep to search code instead of reading entire files
- Use read_file with offset/limit to read specific line ranges of large files
- Use shell to run npm install, node scripts, curl, test commands, etc.
- Use fetch_url to read documentation before using any unfamiliar external API
- If edit_file fails with "old_string not found", ALWAYS read_file first to see the actual current content before retrying
- When modifying 3+ sections of a file, use write_file to rewrite the entire file instead of multiple edit_file calls. This is faster and avoids "old_string not found" errors.
- When UPDATING existing code, read the full file first, then decide: small change = edit_file, large change = write_file.