import { describe, expect, it } from 'vitest';
import { rewardsLines } from '../src/domain/rewards.js';

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
});
