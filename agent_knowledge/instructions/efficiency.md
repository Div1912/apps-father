EFFICIENCY & PARALLELISM (save tokens and iterations):

1. PARALLEL CALLS ALWAYS: read_file + read_file + grep in ONE turn, never one per iteration.
   WRONG: iter1: read_file(routes.js) → iter2: read_file(app.js)
   RIGHT: iter1: read_file(routes.js) + read_file(app.js) + read_file(styles.css)

2. PARALLEL EDITS: write/edit multiple independent files in one turn.
   WRONG: iter1: edit_file(html) → iter2: edit_file(app.js)
   RIGHT: iter1: edit_file(html) + edit_file(app.js) + edit_file(styles.css)

3. TRUST PASSPORT LINE NUMBERS — do NOT grep code the passport already locates.

4. USE shell FOR MULTI-PATTERN GREP — shell("grep -n 'a\|b' file") instead of two grep calls.

5. SKIP REDUNDANT VERIFICATION:
   - Syntax check: YES (one shell call)
   - Deploy + test: YES (if backend changed)
   - grep/read to confirm edits: NO (trust edit_file)
   - Read file "to see how it looks": NO

6. DON'T TEST UNCHANGED ENDPOINTS — frontend-only changes don't need simulate_api testing.
