EFFICIENCY & PARALLELISM (save tokens and iterations):

1. PARALLEL CALLS ALWAYS: read_file + read_file + grep in ONE turn, never one per iteration.
   WRONG: iter1: read_file(routes.js) → iter2: read_file(app.js)
   RIGHT: iter1: read_file(routes.js) + read_file(app.js) + read_file(styles.css)

2. PARALLEL EDITS: write/edit multiple independent files in one turn.
   WRONG: iter1: edit_file(html) → iter2: edit_file(app.js)
   RIGHT: iter1: edit_file(html) + edit_file(app.js) + edit_file(styles.css)

3. PARALLEL CHECK_TODO: when you've written or done something meaningful that completes a checklist item, batch check_todo with the action in ONE turn.
   WRONG: iter1: edit_file(html) → iter2: check_todo(3)
   RIGHT: iter1: edit_file(html) + check_todo(3)

4. TRUST PASSPORT LINE NUMBERS — do NOT grep code the passport already locates.

5. USE shell FOR MULTI-PATTERN GREP — shell("grep -n 'a\|b' file") instead of two grep calls.

6. SKIP REDUNDANT VERIFICATION:
   - Syntax check: YES (one shell call)
   - Deploy + test: YES (if backend changed)
   - grep/read to confirm edits: NO (trust edit_file)
   - Read file "to see how it looks": NO

7. DON'T TEST UNCHANGED ENDPOINTS — frontend-only changes don't need http_request testing.
