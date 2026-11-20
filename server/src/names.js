// Name moderation for display names (index.js cleanName has already cut a name to letters, digits, space _ . - and
// 16 characters). nameAllowed(name, quick) is false for:
//   - slurs, hate and sexual-violence terms: in every room
//   - general swearing and sexual words: in quick play only (strangers); private rooms are friends, so they're allowed
// Evasion it sees through: case, accents, Cyrillic/Greek look-alikes, digits for letters (n1gg3r), separators between
// letters (n.i.g.g.e.r, f u c k, fu ck) and stretched letters (fuuuuck).
// Words that hide inside ordinary names are matched as whole words only (a plural s is allowed): 'ass' blocks "ass"
// and "Big Ass" but not "Cassidy", 'cock' not "Hancock", 'rapist' not "therapist", 'coon' not "Raccoon". Everything
// else is matched anywhere in the name. Each letter of a term may repeat, but letters that are doubled in the term
// must be doubled in the name, so 'nigg' catches "niiigga" and not "Nigel".
// Test: node test/names.mjs (no server needed).

// [term, mode] mode: 'sub' anywhere in a word, 'word' whole word (or the whole name run together), 'phrase' anywhere
// in the whole name run together ("Gas The Jews"), 'raw' anywhere in the name as typed, digits included (1488)
const HARD = [
  ['nigg', 'sub'], ['nigga', 'sub'], ['niglet', 'sub'], ['negro', 'word'], ['faggot', 'sub'], ['faggit', 'sub'], ['fag', 'word'],
  ['retard', 'sub'], ['tranny', 'sub'], ['trannie', 'sub'], ['chink', 'sub'], ['spic', 'word'], ['kike', 'word'], ['coon', 'word'],
  ['gook', 'word'], ['wetback', 'sub'], ['beaner', 'sub'], ['raghead', 'sub'], ['towelhead', 'sub'], ['sandnig', 'sub'],
  ['dyke', 'word'], ['paki', 'word'], ['jigaboo', 'sub'], ['porchmonkey', 'phrase'], ['golliwog', 'sub'], ['wog', 'word'],
  ['hitler', 'sub'], ['heil', 'word'], ['siegheil', 'phrase'], ['nazi', 'word'], ['whitepower', 'phrase'], ['whitepride', 'phrase'],
  ['gasthejews', 'phrase'], ['kkk', 'raw'], ['1488', 'raw'], ['rape', 'word'], ['raper', 'word'], ['rapist', 'word'],
  ['molest', 'sub'], ['pedo', 'word'], ['paedo', 'word'], ['pedophile', 'sub'], ['paedophile', 'sub'], ['nonce', 'word'],
  ['killalljews', 'phrase'], ['killjews', 'phrase'],
];
const SOFT = [
  ['fuck', 'sub'], ['fuk', 'word'], ['fck', 'word'], ['shit', 'sub'], ['cunt', 'sub'], ['cock', 'word'], ['dick', 'word'],
  ['pussy', 'sub'], ['bitch', 'sub'], ['whore', 'sub'], ['slut', 'sub'], ['penis', 'word'], ['vagina', 'sub'], ['porn', 'sub'],
  ['cum', 'word'], ['cumshot', 'sub'], ['tits', 'word'], ['titties', 'sub'], ['boob', 'sub'], ['anal', 'word'], ['anus', 'word'],
  ['sex', 'word'], ['dildo', 'sub'], ['jizz', 'sub'], ['wank', 'word'], ['wanker', 'word'], ['twat', 'sub'], ['bastard', 'word'], ['ass', 'word'],
  ['asshole', 'sub'], ['arse', 'word'], ['arsehole', 'sub'], ['cuck', 'word'], ['blowjob', 'sub'], ['handjob', 'sub'],
  ['milf', 'word'], ['horny', 'word'], ['nude', 'word'], ['nudes', 'word'], ['boner', 'word'], ['testicle', 'sub'],
];

// look-alike letters from other scripts, and digits used as letters
const CONFUSABLE = {
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'м': 'm', 'т': 't', 'н': 'h', 'в': 'b',
  'і': 'i', 'ї': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd', 'ӏ': 'l', 'ɡ': 'g', 'ı': 'i',
  'α': 'a', 'ε': 'e', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'ν': 'v', 'κ': 'k', 'ι': 'i', 'η': 'n', 'χ': 'x',
};
const LEET = { 0: 'o', 1: 'i', 2: 'z', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g' };

function fold(s) {
  s = String(s || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  let o = '';
  for (const ch of s) o += CONFUSABLE[ch] || ch;
  return o;
}
const leet = (s) => s.replace(/[0-9]/g, (d) => LEET[d]);
// each letter may be stretched: 'fuck' -> /f+u+c+k+/; a doubled letter must stay doubled ('nigg' -> /n+i+g+g+/)
const stretch = (t) => t.split('').map((ch) => ch.replace(/[^a-z0-9]/g, '') + '+').join('');
function compile(list) {
  return list.map(([t, mode]) => ({
    mode,
    re: mode === 'raw' ? new RegExp(t) : mode === 'sub' || mode === 'phrase' ? new RegExp(stretch(t)) : new RegExp('^' + stretch(t) + '(e?s)?$'),
  }));
}
const HARD_RE = compile(HARD), SOFT_RE = compile(SOFT);

function hits(rules, raw, joined, words) {
  for (const r of rules) {
    if (r.mode === 'raw') { if (r.re.test(raw)) return true; continue; }
    if (r.mode === 'phrase') { if (r.re.test(words.join(''))) return true; continue; }
    if (r.mode === 'sub') { if (words.some((w) => r.re.test(w)) || (joined && r.re.test(joined))) return true; continue; }
    if ((joined && r.re.test(joined)) || words.some((w) => r.re.test(w))) return true;
  }
  return false;
}

export function nameAllowed(name, quick) {
  const f = fold(name);
  const raw = f.replace(/[\s_.\-]+/g, '');             // digits as typed: 1488
  const words = f.split(/[\s_.\-]+/).filter(Boolean).map(leet);
  // run together only when it looks letter-spaced (a word of 1-2 letters: "f u c k", "fu ck", "n.1.g.g.a"), so two
  // ordinary words don't make a third across the gap ("Bass Hit")
  const joined = words.some((w) => w.length <= 2) ? words.join('') : '';
  if (hits(HARD_RE, raw, joined, words)) return false;
  if (quick && hits(SOFT_RE, raw, joined, words)) return false;
  return true;
}
