// POST /analyze: how the model reads one word — its reading (katakana), its sounds (moras) and its accent type
// (0 = 平板, n = the pitch drops after mora n), so a dictionary entry can be filled in without typing them.
//
// zen-tts/node exports analyze() but not the mora / accent helpers (runtime/tts-own-prosody), so the small part
// needed here is done the same way: a mora ends at a vowel, N or q; the accent type is the mora whose last phone
// carries the fall mark (accentTypeOf).

const MORA_END = new Set(['a', 'i', 'u', 'e', 'o', 'N', 'a:', 'i:', 'u:', 'e:', 'o:', 'q']);
const FALL = 2; // MARK.fall
// The word is read before a particle, as in a sentence: alone the G2P misreads short words, and a final fall
// (尾高, e.g. 明日 = 3) only shows when something follows.
const TAIL = 'は。';
const TAIL_G2P = 'は.';

// mora phones -> katakana, from the voice's own kana table ({kana: [consonant, vowel]}); the first kana wins
// (ワ before ヮ, オ before ヲ).
const kanaTables = new WeakMap();
function kanaOf(tts) {
  if (!kanaTables.has(tts)) {
    const table = new Map();
    for (const [kana, [consonant, vowel]] of Object.entries(tts.tts.meta.kana)) {
      const key = `${consonant}|${vowel}`;
      if (!table.has(key)) table.set(key, kana);
    }
    kanaTables.set(tts, table);
  }
  return kanaTables.get(tts);
}

/** The model's reading of `word` (with the dictionary `dict` applied, as speak() does). */
export function analyzeWord(tts, word, dict = []) {
  const a = tts.analyze(word + TAIL, dict);
  const spans = a.g2p.spans;
  if (!a.aligned || !a.g2pText.endsWith(TAIL_G2P) || spans.length < 3) {
    throw new AnalyzeError(`「${word}」を読めませんでした`);
  }
  const end = spans[spans.length - 2][0]; // the phones before は
  const table = kanaOf(tts);
  const moras = [];
  let accent = 0;
  let start = 0;
  let lastVowel = '';
  for (let i = 0; i < end; i++) {
    const phone = a.phones[i];
    if (!MORA_END.has(phone)) continue;
    const consonant = a.phones.slice(start, i).join('');
    const vowel = phone.replace(':', '');
    let kana;
    if (consonant === '' && vowel === lastVowel && 'aiueo'.includes(vowel)) kana = 'ー'; // トオキョオ -> トーキョー
    else kana = table.get(`${consonant}|${vowel}`);
    if (kana === undefined) throw new AnalyzeError(`「${word}」の音をかなにできませんでした`);
    moras.push(phone.endsWith(':') ? `${kana}ー` : kana);
    if (a.marks[i] === FALL && accent === 0) accent = moras.length;
    lastVowel = vowel === 'N' || vowel === 'q' ? '' : vowel;
    start = i + 1;
  }
  if (moras.length === 0) throw new AnalyzeError(`「${word}」を読めませんでした`);
  return { reading: moras.join(''), moras, accent };
}

export class AnalyzeError extends Error {}
