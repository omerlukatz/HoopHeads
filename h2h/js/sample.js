// Deterministic sample games in the neutral (player1 / player2) shape, used by demo mode.

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P1_TEAMS = ['LAL', 'LAL', 'LAL', 'BOS', 'BOS', 'GSW', 'DEN', 'OKC'];
const P2_TEAMS = ['MIL', 'MIL', 'PHX', 'PHX', 'DAL', 'MIA', 'NYK', 'MIN'];
const NOTES = ['Buzzer beater', 'Down 15 at the half', 'Controller died in Q3', 'Clutch free throws'];
const FIFA_P1 = ['F-RMA', 'F-RMA', 'F-MCI', 'F-MCI', 'F-FCB', 'F-ARS', 'F-PSG'];
const FIFA_P2 = ['F-LIV', 'F-LIV', 'F-BAR', 'F-BAR', 'F-INT', 'F-MUN', 'F-ARG'];
const FIFA_NOTES = ['Last-minute winner', 'Own goal decided it', 'Red card in the first half', 'Weekend league warm-up'];

/** A FIFA scoreline from p1's side: 'W', 'D' or 'L' (typical 0–4 goals a side). */
function fifaScore(rand, result) {
  const goals = () => Math.min(5, Math.floor(-Math.log(1 - rand()) * 1.4));
  if (result === 'D') {
    const g = Math.min(3, goals());
    return [g, g];
  }
  const loser = Math.min(3, goals());
  const winner = loser + 1 + (rand() < 0.35 ? Math.floor(rand() * 3) : 0);
  return result === 'W' ? [winner, loser] : [loser, winner];
}

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** `script` fixes the newest results from p1's side (true = p1 wins), so previews tell a story. */
export function generateSampleGames(p1, p2, { count = 38, seed = 2026, startDaysAgo = 1, script = [true, true, true, false, true], sport = '2k' } = {}) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const games = [];
  const day = new Date();
  day.setDate(day.getDate() - startDaysAgo);

  // Walk back in time, 1–3 games per session every few days.
  while (games.length < count) {
    const sessionGames = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < sessionGames && games.length < count; i++) {
      const created = new Date(day);
      created.setHours(21, 30 - i * 25);
      // Never in the future (today's sample games would otherwise sort after games you log now)
      const stamp = new Date(Math.min(created.getTime(), Date.now() - (games.length + 1) * 3600000)).toISOString();
      if (sport === 'fifa') {
        // script: true = p1 wins, false = p2 wins, null = draw
        const scripted = script[games.length];
        const roll = rand();
        const result = scripted === true ? 'W' : scripted === false ? 'L' : scripted === null ? 'D' : roll < 0.44 ? 'W' : roll < 0.7 ? 'D' : 'L';
        const [s1, s2] = fifaScore(rand, result);
        const extraTime = result === 'D' ? rand() < 0.3 : rand() < 0.08 && Math.abs(s1 - s2) === 1;
        const shootout = result === 'D' && extraTime && rand() < 0.7;
        const pensWinner = 3 + Math.floor(rand() * 3);
        const p1Pens = rand() < 0.5;
        games.push({
          id: `sample-fifa-${p1}-${p2}-${games.length}`,
          sport: 'fifa',
          date: iso(day),
          player1_id: p1,
          player2_id: p2,
          player1_score: s1,
          player2_score: s2,
          player1_pens: shootout ? (p1Pens ? pensWinner : pensWinner - 1 - Math.floor(rand() * 2)) : '',
          player2_pens: shootout ? (p1Pens ? pensWinner - 1 - Math.floor(rand() * 2) : pensWinner) : '',
          player1_team: pick(FIFA_P1),
          player2_team: pick(FIFA_P2),
          overtime: extraTime,
          note: rand() < 0.15 ? pick(FIFA_NOTES) : '',
          created_by: rand() < 0.6 ? p1 : p2,
          created_at: stamp,
          updated_at: stamp,
          deleted: false,
        });
        continue;
      }
      const p1Wins = script[games.length] ?? rand() < 0.52;
      const close = rand() < 0.3;
      const diff = close ? 1 + Math.floor(rand() * 4) : 3 + Math.floor(rand() * (rand() < 0.15 ? 30 : 16));
      const loser = 84 + Math.floor(rand() * 30);
      const winner = loser + diff;
      games.push({
        id: `sample-${p1}-${p2}-${games.length}`,
        date: iso(day),
        player1_id: p1,
        player2_id: p2,
        player1_score: p1Wins ? winner : loser,
        player2_score: p1Wins ? loser : winner,
        player1_team: pick(P1_TEAMS),
        player2_team: pick(P2_TEAMS),
        overtime: close && rand() < 0.5,
        note: rand() < 0.15 ? pick(NOTES) : '',
        created_by: rand() < 0.6 ? p1 : p2,
        created_at: stamp,
        updated_at: stamp,
        deleted: false,
      });
    }
    day.setDate(day.getDate() - (2 + Math.floor(rand() * 5)));
  }
  return games;
}
