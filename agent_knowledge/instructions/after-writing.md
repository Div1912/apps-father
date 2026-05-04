AFTER WRITING CODE — DO NOT RE-READ:
- After a successful edit_file or write_file, the confirmation ("OK: Replaced 1 occurrence" / "OK: Written N lines") proves the change was applied. Do NOT re-read the same file to "verify" your edit.
- Only re-read a file if you need the EXACT current content for a SUBSEQUENT edit_file on that same file (because old_string must match current content).
- If you're done editing a file, move on to the next file or task. Never read a file just to confirm it looks right.

AF SDK VALIDATOR — run this checklist before calling finish():
After writing index.html and app.js, check each point. Fix any violations immediately:
1. index.html has <script src="/af-sdk.js"> in <head>, BEFORE app.js? If not → add it.
2. app.js calls AF.init({ project_id, colors })? If not → replace all manual tg.* init calls with AF.init().
3. app.js defines apiCall() / API_BASE / API_URL / fetchApi()? If yes → DELETE those and replace all calls with AF.api().
4. Any AF.api() call passes endpoint starting with "/"? If yes → remove the leading slash.
5. app.js uses localStorage directly? If yes → replace with AF.storage.get/set/remove().
6. app.js calls tg.HapticFeedback directly? If yes → replace with AF.haptic().
7. app.js calls tg.BackButton directly? If yes → replace with AF.back().
8. app.js accesses Telegram.WebApp.initDataUnsafe?.user directly? If yes → replace with AF.user.
