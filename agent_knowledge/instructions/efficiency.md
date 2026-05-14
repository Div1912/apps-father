EFFICIENCY & PARALLELISM (save tokens and iterations):

⚠️ HARD LIMIT: You have at most ~50 iterations per session. Every tool call costs one iteration.
If you make 20 tiny edit_file calls for string replacements, that is 20 wasted iterations — you WILL hit the limit before finishing. Budget carefully.

1. PARALLEL CALLS ALWAYS: read_file + read_file + grep in ONE turn, never one per iteration.
   WRONG: iter1: read_file(routes.js) → iter2: read_file(app.js)
   RIGHT: iter1: read_file(routes.js) + read_file(app.js) + read_file(styles.css)

2. PARALLEL EDITS: write/edit multiple independent files in ONE turn.
   WRONG: iter1: edit_file(html) → iter2: edit_file(app.js)
   RIGHT: iter1: edit_file(html) + edit_file(app.js) + edit_file(styles.css)

3. BATCH STRING REPLACEMENTS — if you need to change 3+ strings in one file, use write_file to rewrite the whole file in a single turn. Do NOT make a separate edit_file call per string.
   WRONG: iter1: edit_file("Good day"→"Добрый день") → iter2: edit_file("Loading"→"Загрузка") → iter3: edit_file("No matches"→"Ничего не найдено") ...
   RIGHT: iter1: read_file(app.js) + write_file(app.js, <full updated content>)

   For files >300 lines, write_file's content can hit max_tokens and get truncated. Use chunked appends instead — do NOT fall back to shell:
     write_file({ path, content: "<first ~200 lines>" })
     write_file({ path, content: "<next ~200 lines>", append: true })
     write_file({ path, content: "<final lines>", append: true })

4. TRUST PASSPORT LINE NUMBERS — do NOT grep code the passport already locates.

5. USE shell FOR MULTI-PATTERN GREP — shell("grep -n 'a\|b' file") instead of two grep calls.

6. NEVER RE-READ A FILE TO CONFIRM AN EDIT:
   - After edit_file returns "OK: Replaced 1 occurrence", the change is applied. Move on.
   - Only re-read if you need the EXACT current content for a SUBSEQUENT edit on that same file.
   - WRONG: edit_file(...) → read_file(...) to verify → then continue
   - RIGHT: edit_file(...) → continue immediately to next file/task

7. DON'T TEST UNCHANGED ENDPOINTS — frontend-only changes don't need simulate_api testing.
