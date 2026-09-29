// Pure stat functions. Games are stored neutrally (player1 / player2); everything here is
// computed from one player's point of view. No DOM, no storage: easy to test and tweak.

/** Converts a neutral game into "me vs opponent" for `playerId`. */
export function perspective(game, playerId) {
  const mine = game.player2_id === playerId ? 2 : 1;
  const theirs = mine === 1 ? 2 : 1;
  const myScore = Number(game[`player${mine}_score`]);
  const oppScore = Number(game[`player${theirs}_score`]);
  return {
    id: game.id,
    date: game.date,
    myScore,
    oppScore,
    myTeam: game[`player${mine}_team`],
    oppTeam: game[`player${theirs}_team`],
    overtime: Boolean(game.overtime),
    note: game.note || '',
    win: myScore > oppScore,
    margin: myScore - oppScore,
    createdBy: game.created_by,
    createdAt: game.created_at || '',
    pending: Boolean(game._pending),
  };
}

const newestFirst = (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt);

/** All non-deleted games from `playerId`'s side, newest first. */
export function views(games, playerId) {
  return games.filter((g) => !g.deleted).map((g) => perspective(g, playerId)).sort(newestFirst);
}

/**
 * Stats for one player. Returns { total: 0 } when there are no games.
 * `streak.win` is true for a winning streak, false for a losing one.
 */
export function computeStats(games, playerId) {
  const list = views(games, playerId).reverse(); // oldest → newest
  const total = list.length;
  if (!total) return { total: 0 };

  let wins = 0, pointsFor = 0, pointsAgainst = 0;
  let run = 0, runWin = null, longestWin = 0, longestLoss = 0;
  let biggestWin = null, closest = null;

  for (const g of list) {
    if (g.win) wins++;
    pointsFor += g.myScore;
    pointsAgainst += g.oppScore;

    run = g.win === runWin ? run + 1 : 1;
    runWin = g.win;
    if (g.win) longestWin = Math.max(longestWin, run);
    else longestLoss = Math.max(longestLoss, run);

    // `>=` / `<=` so ties resolve to the most recent game
    if (g.win && (!biggestWin || g.margin >= biggestWin.margin)) biggestWin = g;
    if (!closest || Math.abs(g.margin) <= Math.abs(closest.margin)) closest = g;
  }

  return {
    total,
    wins,
    losses: total - wins,
    pct: wins / total,
    streak: { win: runWin, count: run },
    longestWin,
    longestLoss,
    avgFor: pointsFor / total,
    avgAgainst: pointsAgainst / total,
    avgMargin: (pointsFor - pointsAgainst) / total,
    biggestWin,
    closest,
    last5: list.slice(-5).map((g) => g.win), // oldest → newest
    latest: list.at(-1),
  };
}

/** Wins/losses for a subset of perspective views (e.g. one month). */
export function record(viewList) {
  const wins = viewList.filter((g) => g.win).length;
  return { wins, losses: viewList.length - wins };
}

/** Most recently used distinct teams from views (newest first). `key` is 'myTeam' or 'oppTeam'. */
export function recentTeams(viewList, key, limit = 5) {
  const seen = [];
  for (const g of viewList) {
    if (!seen.includes(g[key])) seen.push(g[key]);
    if (seen.length === limit) break;
  }
  return seen;
}

// ---------- over time ----------

export const RATING_START = 1200;
const K = 24;

/**
 * One point per game, oldest → newest, from `playerId`'s side:
 *   rating  – head-to-head Elo. Both players start at 1200 and the ratings mirror each other
 *             (theirs = 2400 − yours). Beating a higher-rated opponent earns more, and the margin
 *             nudges it: a 1-point game counts ~0.85×, a 30-point blowout 1.25× (never more).
 *   lead    – net wins so far (wins − losses).
 *   winPct  – win percentage so far.
 * `t` is a timestamp: the game's date, with same-day games spread across that day in play order.
 */
export function timeline(games, playerId) {
  const list = views(games, playerId).reverse();
  const perDay = new Map();
  list.forEach((g) => perDay.set(g.date, (perDay.get(g.date) || 0) + 1));
  const seen = new Map();
  let rating = RATING_START, wins = 0;
  return list.map((g, i) => {
    const opp = 2 * RATING_START - rating;
    const expected = 1 / (1 + 10 ** ((opp - rating) / 400));
    const mov = Math.min(1.25, 0.75 + (0.5 * Math.log(Math.abs(g.margin) + 1)) / Math.log(31));
    rating += K * mov * ((g.win ? 1 : 0) - expected);
    if (g.win) wins++;
    const k = seen.get(g.date) || 0;
    seen.set(g.date, k + 1);
    const [y, m, d] = g.date.split('-').map(Number);
    const t = new Date(y, m - 1, d).getTime() + ((k + 1) / (perDay.get(g.date) + 1)) * 86400000;
    return { t, game: g, rating, lead: 2 * wins - (i + 1), winPct: (wins / (i + 1)) * 100 };
  });
}

// ---------- teams, clutch, activity ----------

/**
 * Record by team. `key` is 'myTeam' (teams you used) or 'oppTeam' (teams your friend used).
 * Sorted by games played, then win rate.
 */
export function teamRecords(viewList, key) {
  const by = new Map();
  for (const g of viewList) {
    const r = by.get(g[key]) || { abbr: g[key], wins: 0, losses: 0 };
    g.win ? r.wins++ : r.losses++;
    by.set(g[key], r);
  }
  return [...by.values()]
    .map((r) => ({ ...r, games: r.wins + r.losses, pct: r.wins / (r.wins + r.losses) }))
    .sort((a, b) => b.games - a.games || b.pct - a.pct || a.abbr.localeCompare(b.abbr));
}

export const CLOSE_MARGIN = 5;
export const BLOWOUT_MARGIN = 15;

/** Records in close games (≤5), overtime games and blowouts (15+). */
export function clutch(viewList) {
  const rec = (list) => record(list);
  return {
    close: rec(viewList.filter((g) => Math.abs(g.margin) <= CLOSE_MARGIN)),
    overtime: rec(viewList.filter((g) => g.overtime)),
    blowouts: rec(viewList.filter((g) => Math.abs(g.margin) >= BLOWOUT_MARGIN)),
  };
}

/** Games per calendar day: Map 'YYYY-MM-DD' → { wins, losses }. */
export function activityByDay(viewList) {
  const days = new Map();
  for (const g of viewList) {
    const d = days.get(g.date) || { wins: 0, losses: 0 };
    g.win ? d.wins++ : d.losses++;
    days.set(g.date, d);
  }
  return days;
}
