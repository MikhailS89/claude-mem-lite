// A deliberately light stemmer for search *queries* (never for stored text).
//
// Stored words are indexed as they are, and every query term is a prefix
// match ("кэш"* finds кэш, кэша, кэшу). What failed was the other direction:
// a query in a longer form than the stored word ("кэша" does not find "кэш",
// "parsers" does not find "parser"). Cutting the ending off the query term
// turns it into a prefix of every form, so any form finds any other.
//
// It over-reaches a little ("баз" also finds "базовый") - acceptable for
// searching one's own work history, where missing a session is worse than an
// extra hit. Stems are kept at 3+ letters so short words are not destroyed.

/** Russian noun, adjective and verb endings, longest first. */
const RU_ENDINGS = [
  'ованиями', 'ованием', 'ования', 'ование', 'овании',
  'иями', 'ями', 'ами', 'иях', 'ией', 'иям', 'ием', 'ого', 'его', 'ому', 'ему', 'ыми', 'ими', 'ешь', 'ишь', 'ете', 'ите', 'ться', 'тся',
  'ия', 'ие', 'ии', 'ий', 'ый', 'ой', 'ей', 'ая', 'яя', 'ое', 'ее', 'ую', 'юю', 'ом', 'ем', 'ам', 'ям', 'ах', 'ях', 'ов', 'ев', 'ью', 'ет', 'ют', 'ит', 'ят', 'ть', 'ла', 'ло', 'ли',
  'ы', 'и', 'а', 'я', 'о', 'е', 'у', 'ю', 'ь', 'й',
].sort((a, b) => b.length - a.length);

/** English inflections worth dropping, longest first. */
const EN_ENDINGS = ['ings', 'ing', 'ied', 'ies', 'ed', 'es', 's'];

const MIN_STEM = 3;

/**
 * SQLite's unicode61 tokenizer treats ё and е as different letters, and
 * people type е where the text has ё (and the other way round). Everything
 * that goes into the search index, and every query, is folded to е.
 */
export function foldText(text) {
  return String(text ?? '').replace(/ё/g, 'е').replace(/Ё/g, 'Е');
}

/**
 * The query form of one word: its stem when it is a plain Russian or English
 * word, otherwise the word unchanged (paths, shas, identifiers with digits,
 * dots or dashes are searched as typed).
 */
export function stem(word) {
  const w = String(word).toLowerCase();
  if (/^[а-яё]+$/.test(w)) return cut(foldText(w), RU_ENDINGS);
  if (/^[a-z]+$/.test(w)) {
    if (w.endsWith('ss')) return w; // class, process
    return cut(w, EN_ENDINGS);
  }
  return w;
}

function cut(w, endings) {
  for (const e of endings) {
    if (w.endsWith(e) && w.length - e.length >= MIN_STEM) return w.slice(0, -e.length);
  }
  return w;
}
