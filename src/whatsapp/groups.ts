/** Resumo de um chat do WhatsApp Web: só identificação, nunca mensagens. */
export interface ChatSummary {
  id: string;
  name: string;
  isGroup: boolean;
}

export interface GroupListing {
  totalChats: number;
  groups: { id: string; name: string }[];
}

/** Filtra os grupos (id `@g.us`) e ordena por nome para exibição. */
export function listGroupsFrom(chats: ChatSummary[]): GroupListing {
  const groups = chats
    .filter((c) => c.isGroup && c.id.endsWith('@g.us'))
    .map((c) => ({ id: c.id, name: c.name || '(sem nome)' }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return { totalChats: chats.length, groups };
}

/** Texto do `wa:chats`: contagens seguidas de nome e ID de cada grupo. */
export function formatGroupListing({ totalChats, groups }: GroupListing): string {
  const lines = [`Chats carregados: ${totalChats}`, `Grupos encontrados: ${groups.length}`];
  for (const g of groups) lines.push('', g.name, g.id);
  if (groups.length === 0) lines.push('', 'Nenhum grupo encontrado. Confirme que o número do bot participa do grupo desejado.');
  return lines.join('\n');
}
