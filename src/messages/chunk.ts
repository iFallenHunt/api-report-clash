/**
 * Divide uma mensagem longa em partes numeradas, quebrando em linhas em branco
 * (blocos) sempre que possível. Limite conservador e configurável.
 */
export function splitMessage(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const blocks = text.split(/\n\n+/);
  const parts: string[] = [];
  let current = '';
  const headerRoom = 12; // espaço para "(10/10)\n"
  const limit = Math.max(200, maxChars - headerRoom);
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) parts.push(current);
    if (block.length <= limit) {
      current = block;
    } else {
      // bloco gigante: quebra por linha
      current = '';
      for (const line of block.split('\n')) {
        const c2 = current ? `${current}\n${line}` : line;
        if (c2.length <= limit) current = c2;
        else {
          if (current) parts.push(current);
          current = line.slice(0, limit);
        }
      }
    }
  }
  if (current) parts.push(current);
  const total = parts.length;
  return parts.map((p, i) => `(${i + 1}/${total})\n${p}`);
}
