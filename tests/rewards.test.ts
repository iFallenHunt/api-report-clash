import { describe, expect, it } from 'vitest';
import { rewardQuotes, rewardsLines } from '../src/domain/rewards.js';

describe('recompensas', () => {
  it('diferencia "não divulgadas" de "não verificadas"', () => {
    expect(rewardsLines('not_announced', [], null)).toEqual(['🎁 Recompensas ainda não divulgadas']);
    expect(rewardsLines('unverified', [], 'https://x')[0]).toContain('não foi possível verificar');
    // status known mas lista vazia também não inventa nada
    expect(rewardsLines('known', [], null)[0]).toContain('não foi possível verificar');
  });

  it('separa gratuitas de pagas e mostra quantidades e condições', () => {
    const lines = rewardsLines(
      'known',
      [
        { label: 'Medalhas', quantity: 1200, condition: 'completar a trilha', tier: 'free' },
        { label: 'Visual Lendário', tier: 'paid', condition: 'Passe Ouro' },
        { label: 'Poção', tier: 'unknown' },
      ],
      null,
    );
    const text = lines.join('\n');
    expect(text).toContain('🎁 *Recompensas*');
    expect(text).toContain('_Gratuitas:_');
    expect(text).toContain('• 1200x Medalhas — completar a trilha');
    expect(text).toContain('💳 *Passe/conteúdo pago:*');
    expect(text).toContain('• Visual Lendário — Passe Ouro');
    expect(text).toContain('Sem indicação se são gratuitas ou pagas');
    // item pago nunca aparece na seção gratuita
    const freeSection = text.split('💳')[0]!;
    expect(freeSection).not.toContain('Visual Lendário');
  });

  it('apresenta opções como escolha', () => {
    const text = rewardsLines('known', [
      { label: 'Poção de Construtor', quantity: 2, tier: 'free', choiceGroup: 'n10', condition: 'nível 10: escolha 1' },
      { label: 'Livro de Feitiços', quantity: 1, tier: 'free', choiceGroup: 'n10' },
    ], null).join('\n');
    expect(text).toContain('Escolha 1 entre: 1x Livro de Feitiços / 2x Poção de Construtor');
    expect(text).toContain('↳ nível 10: escolha 1');
  });

  it('sem lista estruturada: cita literalmente as frases da fonte sobre recompensas; loja identificada; probabilidade fora', () => {
    const desc = 'Os portais misturaram mundos! Colete elixir ácido nas batalhas, liberando medalhas da fenda, tropas temporárias e outras recompensas. Depois, você pode gastar essas medalhas na loja do Comerciante para obter o novo equipamento, o Portal Portátil. A chance de baú raro é de 5%. E lembre-se: a loja do Comerciante fica aberta até 27 de outubro.';
    const q = rewardQuotes(desc);
    expect(q.map((x) => x.shop)).toEqual([false, true, true]);
    expect(q[0]!.text).toBe('Colete elixir ácido nas batalhas, liberando medalhas da fenda, tropas temporárias e outras recompensas.');
    expect(q.some((x) => x.text.includes('5%'))).toBe(false);
    const lines = rewardsLines('unverified', [], 'https://x', desc);
    expect(lines[0]).toBe('🎁 Segundo a Supercell: “Colete elixir ácido nas batalhas, liberando medalhas da fenda, tropas temporárias e outras recompensas.”');
    expect(lines[1]).toContain('🛒 Loja do evento (não é prêmio garantido)');
    // sem nenhuma frase de recompensa: continua "não foi possível verificar" (≠ "não divulgadas")
    expect(rewardsLines('unverified', [], 'https://x', 'Uma profanaçãozinha de túmulos em busca de tesouros.')).toEqual(['🎁 Recompensas: não foi possível verificar automaticamente (veja a fonte)']);
    expect(rewardsLines('not_announced', [], 'https://x', desc)).toEqual(['🎁 Recompensas ainda não divulgadas']);
  });

  it('visual de herói do Bilhete dourado vira citação; recompensa só no parêntese cita o parêntese', () => {
    expect(rewardQuotes('Libere recompensas, acelere o seu progresso e resgate o visual de herói exclusivo desta temporada: Rainha Aterradora. Dizem que ela é terrível. Nem queira saber mais... É aterrorizante (Campeã Fantasma é a opção de visual alternativo do mês).').map((q) => q.text)).toEqual([
      'Libere recompensas, acelere o seu progresso e resgate o visual de herói exclusivo desta temporada: Rainha Aterradora.',
      'Campeã Fantasma é a opção de visual alternativo do mês.',
    ]);
  });
});
