interface PendingQuestion {
  resolve: (answer: string) => void;
  projectId: string;
  chatId: number;
  options: string[];
  createdAt: number;
}

const pendingByProject = new Map<string, PendingQuestion>();
const pendingByChat = new Map<number, PendingQuestion>();

const MIN_ANSWER_DELAY_MS = 3000;

export function setPending(
  projectId: string,
  chatId: number,
  options: string[],
  resolve: (answer: string) => void,
) {
  const q: PendingQuestion = { resolve, projectId, chatId, options, createdAt: Date.now() };
  pendingByProject.set(projectId, q);
  pendingByChat.set(chatId, q);
}

export function resolveByProject(projectId: string, answer: string): boolean {
  const q = pendingByProject.get(projectId);
  if (!q) return false;
  pendingByProject.delete(projectId);
  pendingByChat.delete(q.chatId);
  q.resolve(answer);
  return true;
}

export function resolveByChat(chatId: number, answer: string, messageDate?: number): boolean {
  const q = pendingByChat.get(chatId);
  if (!q) return false;

  if (messageDate !== undefined) {
    const msgTimeMs = messageDate * 1000;
    if (msgTimeMs < q.createdAt + MIN_ANSWER_DELAY_MS) {
      return false;
    }
  } else {
    if (Date.now() - q.createdAt < MIN_ANSWER_DELAY_MS) {
      return false;
    }
  }

  pendingByProject.delete(q.projectId);
  pendingByChat.delete(chatId);
  q.resolve(answer);
  return true;
}

export function hasPendingForChat(chatId: number): boolean {
  const q = pendingByChat.get(chatId);
  if (!q) return false;
  if (Date.now() - q.createdAt < MIN_ANSWER_DELAY_MS) return false;
  return true;
}

export function getPendingByProject(projectId: string): PendingQuestion | undefined {
  return pendingByProject.get(projectId);
}
