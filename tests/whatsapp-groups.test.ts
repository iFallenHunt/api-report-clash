import { describe, expect, it } from 'vitest';
import { formatGroupListing, listGroupsFrom } from '../src/whatsapp/groups.js';

describe('wa:chats (listagem de grupos)', () => {
  const chats = [
    { id: '5511999999999@c.us', name: 'Contato', isGroup: false },
    { id: '120363000000000002@g.us', name: 'Família', isGroup: true },
    { id: '120363000000000001@g.us', name: 'Clãdestino', isGroup: true },
    { id: '120363000000000003@newsletter', name: 'Canal', isGroup: false },
    { id: '120363000000000004@g.us', name: '', isGroup: true },
  ];

  it('mantém só grupos @g.us, ordenados por nome, e conta todos os chats', () => {
    const r = listGroupsFrom(chats);
    expect(r.totalChats).toBe(5);
    expect(r.groups).toEqual([
      { id: '120363000000000004@g.us', name: '(sem nome)' },
      { id: '120363000000000001@g.us', name: 'Clãdestino' },
      { id: '120363000000000002@g.us', name: 'Família' },
    ]);
  });

  it('imprime contagens e, para cada grupo, nome e ID serializado', () => {
    const text = formatGroupListing(listGroupsFrom(chats.slice(0, 3)));
    expect(text).toBe(
      ['Chats carregados: 3', 'Grupos encontrados: 2', '', 'Clãdestino', '120363000000000001@g.us', '', 'Família', '120363000000000002@g.us'].join('\n'),
    );
  });

  it('explica quando não há grupos em vez de sair em silêncio', () => {
    expect(formatGroupListing(listGroupsFrom([]))).toContain('Grupos encontrados: 0\n\nNenhum grupo encontrado');
  });
});
