// Name moderation (src/names.js), no server needed: node test/names.mjs
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../src/names.js', import.meta.url), 'utf8');
const { nameAllowed } = await import('data:text/javascript,' + encodeURIComponent(src));
let fails = 0;
const check = (name, quick, want) => { const got = nameAllowed(name, quick); if (got !== want) { fails++; console.log(`FAIL ${JSON.stringify(name)} ${quick ? 'quick' : 'private'}: ${got ? 'allowed' : 'blocked'}`); } };
// blocked everywhere (slurs, hate, sexual violence), including the usual disguises
for (const n of ['nigger', 'NIGGA', 'n1gg3r', 'n.i.g.g.e.r', 'n i g g a', 'niiiigggaaa', 'nіgger' /* Cyrillic і */, 'Ｎｉｇｇｅｒ' /* full width */,
  'faggot', 'f4gg0t', 'fag', 'fags', 'retard', 'r3tard3d', 'tranny', 'Hitler', 'H1tl3r', 'heil', 'Sieg Heil', 'nazi', 'Nazis', '1488', 'KKK',
  'rapist', 'r4pe', 'pedo', 'kike', 'spic', 'coon', 'wetback', 'Gas The Jews', 'white power', 'Porch Monkey']) { check(n, false, false); check(n, true, false); }
// blocked in quick play, fine with friends
for (const n of ['fuck', 'FuUuUck', 'f u c k', 'fu ck', 'Shit Lord', 'sh1t', 'cunt', 'dick', 'Big Dick', 'pussy', 'bitch', 'ass', 'Big Ass',
  'asshole', 'cum', 'tits', 'porn star', 'wanker', 'sex', 'b00bs']) { check(n, true, false); check(n, false, true); }
// ordinary names that contain a bad word somewhere, plus normal names
for (const n of ['Nigel', 'Niger', 'Cassidy', 'Dickens', 'Hancock', 'therapist', 'Grape', 'Raccoon', 'Analyst', 'Sussex', 'Nazir', 'Pakistan',
  'Bass Hit', 'Swanky', 'Cuckoo', 'Cumberbatch', 'Classic', 'Assassin', 'Pedro', 'Spicy', 'Heilman', 'Peniston', 'Shell', 'Mass Hitter',
  'Player', 'Ghost', 'xX_Sniper_Xx', 'Zoë', 'Łukasz', 'Søren', 'Ольга', '王小明', 'Ana', '88', 'Echo-7']) { check(n, false, true); check(n, true, true); }
console.log(fails ? fails + ' FAILED' : 'all passed'); process.exit(fails ? 1 : 0);
