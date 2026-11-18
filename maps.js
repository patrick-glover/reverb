// maps.js — REVERB map definitions (see SPEC "Map format"). 1 char = 2 m tile; rows = +Z, columns = +X.
// Legend: # wall  . floor  _ carpet  ~ puddle  = metal grate  S spawn  + health  d darts
//         T table(+chairs; adjacent T merge)  c chair  B bookshelf/rack  C crates  P pillar  O couch  K counter
//         b bed  L lamp/plant/drums  D desk+chair  G glass partition  | half wall
// Optional: theme ('apartment'|'office'|'warehouse', defaults to name), extras (set pieces built by props.js).
(function () {
  'use strict';
  const R = (window.R = window.R || {});

  R.maps = [
    {
      // Cramped flat: bedroom / wet bathroom / kitchen up top, carpet hallway spine, living room + study below.
      // Loops: bedroom-bath-kitchen side doors, 5 hallway doors, two living<->study doors.
      name: 'Apartment', theme: 'apartment', ceiling: 2.8,
      grid: [
        '########################',
        '#b___B#K~~~#KKK.S..KKKK#',
        '#_____#~~+~#B.........L#',
        '#__S__.~~~~..KK....T..S#',
        '#L___c#~~~~#C..L...C..O#',
        '#C___B#~~~K#K....L...KK#',
        '###.####.#####.####.####',
        '#.___________________d.#',
        '###.####.###.####.###.##',
        '#B.....L.|...B#D___B__b#',
        '#C...L...|D...#_______L#',
        '#O......K|..S.._____S__#',
        '#O..c.d....c..#_O_+____#',
        '#L...C...|....#C______B#',
        '#.....B..|.T..#___L____#',
        '#..+.....|....._______D#',
        '#B..CC..L|.S.B#S_B____c#',
        '########################',
      ],
    },
    {
      // Office floor: conference / break room / server room (loud grates) up top, north corridor,
      // lobby (W), open-plan desk pods with glass partitions and a half-wall spine (centre), two offices (E),
      // south corridor with puddled door thresholds, storage + washrooms below.
      name: 'Office', theme: 'office', ceiling: 3.2,
      grid: [
        '##########################',
        '#B.......B#K~~K#==C=C==C=#',
        '#...TTT...#~~~~#==S====C=#',
        '#L......S.#..+.#=C==d==C=#',
        '###.####.####.###.####.###',
        '#........................#',
        '#..O..#_D_D_|__D_D_###.###',
        '#......_GGG_|__GGG_#B...D#',
        '#.KK..#_D_D_|__D_D_...S.c#',
        '#....L#____S_______#L....#',
        '#c.c..#_D_D_|__D_D_#######',
        '#......_GGG_|__GGG_#D.B..#',
        '#O....#_D_D_|__D_D_.....+#',
        '#O.S.L#____________#...L.#',
        '###.#####.######.#####.###',
        '#........~..d...~........#',
        '####.####.#####.#####.####',
        '#CC..C.CC..C#~~~~..K.K.K.#',
        '#C.S..C...+..~~~~~S......#',
        '##########################',
      ],
    },
    {
      // Warehouse: tall open hall with steel columns, a loud grate catwalk band across the middle,
      // pallet-rack aisles (NE), site office (NW), loading dock with puddles + forklift (S), tool cage (SE).
      name: 'Warehouse', theme: 'warehouse', ceiling: 6.0,
      grid: [
        '##########################',
        '#B__D_#.....C.......CC.S.#',
        '#_S_c_...P....BBBBBB.....#',
        '#L___+#..........d.......#',
        '#O___B#.....C.BBBBBB...C.#',
        '###.###..CC.......C......#',
        '#S....C.....C...........S#',
        '#...C....P......P.....P..#',
        '#....CC......C.......C...#',
        '#....======+=======......#',
        '#C...==============....C.#',
        '#.......C....S.......CC..#',
        '#..C.....P......P.....P..#',
        '#.....CC.........C.......#',
        '#.....d...........###.####',
        '#C......~~........#K....K#',
        '#.S.....~~~...........+..#',
        '#C.....~~~~.....C.#K..S.K#',
        '#CC.....~~~.......#BB..KK#',
        '##########################',
      ],
      extras: [
        { kind: 'forklift', tx: 13, tz: 16, dir: 1 },
        { kind: 'rollup', tx: 4, tz: 18, dir: 2 },
        { kind: 'rollup', tx: 9, tz: 18, dir: 2 },
        { kind: 'rollup', tx: 14, tz: 18, dir: 2 },
      ],
    },
  ];
})();
