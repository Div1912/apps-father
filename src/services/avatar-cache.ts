/**
 * Shared in-memory cache for project/user avatar URLs.
 * Keyed by projectId or userId → resolved CDN/Telegram file URL.
 * Populated by server.ts when listing projects; read by app-store.service.ts.
 */
export const avatarCache = new Map<string, string>();
