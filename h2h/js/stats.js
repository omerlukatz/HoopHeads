// Pure stat functions. Games are stored neutrally (player1 / player2); everything here is
// computed from one player's point of view. No DOM, no storage: easy to test and tweak.
//
// Two sports share these functions. NBA 2K games always have a winner. FIFA games can be draws,
// and a level game can be settled by a penalty shootout (which then counts as the win).

/** 'fifa' or '2k' (games logged before FIFA existed have no sport and are 2K). */
export const sportOf = (game) => (game.sport === 'fifa' ? 'fifa' : '2k');

/** Converts a neutral game into "me vs opponent" for `playerId`. */
export function perspective(game, playerId) {
  const mine = game.player2_id === playerId ? 2 : 1;
  const theirs = mine === 1 ? 2 : 1;
  const myScore = Number(game[`player${mine}_score`]);
  const oppScore = Number(game[`player${theirs}_score`]);
  const pens = (n) => (game[`player${n}_pens`] === '' || game[`player${n}_pens`] == null ? null : Number(game[`player${n}_pens`]));
  const myPens = pens(mine), oppPens = pens(theirs);
  const shootout = myScore === oppScore && myPens != null && oppPens != null && myPens !== oppPens;
  const win = myScore > oppScore || (shootout && myPens > oppPens);
  const loss = myScore < oppScore || (shootout && myPens < oppPens);
  return {
    id: game.id,
    date: game.date,
    myScore,
    oppScore,
    myTeam: game[`player${mine}_team`],
    oppTeam: game[`player${theirs}_team`],
    oppId: game[`player${theirs}_id`],
    overtime: Boolean(game.overtime), // 2K: overtime · FIFA: extra time
    sport: sportOf(game),
    shootout,
    myPens: shootout ? myPens : null,
    oppPens: shootout ? oppPens : null,
    note: game.note || '',
    win,
    loss,
    draw: !win && !loss,
    result: win ? 'W' : loss ? 'L' : 'D',
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
 * `streak.result` is 'W', 'D' or 'L' (`streak.win` is kept for the W/L-only views).
 * A draw breaks both a winning and a losing run.
 */
export function computeStats(games, playerId) {
  const list = views(games, playerId).reverse(); // oldest → newest
  const total = list.length;
  if (!total) return { total: 0 };

  let wins = 0, draws = 0, pointsFor = 0, pointsAgainst = 0;
  let run = 0, runResult = null, longestWin = 0, longestLoss = 0;
  let unbeatenRun = 0, longestUnbeaten = 0;
  let cleanSheets = 0, oppCleanSheets = 0;
  let biggestWin = null, closest = null, mostGoals = null;

  for (const g of list) {
    if (g.win) wins++;
    if (g.draw) draws++;
    pointsFor += g.myScore;
    pointsAgainst += g.oppScore;
    if (g.oppScore === 0) cleanSheets++;
    if (g.myScore === 0) oppCleanSheets++;

    run = g.result === runResult ? run + 1 : 1;
    runResult = g.result;
    if (g.win) longestWin = Math.max(longestWin, run);
    if (g.loss) longestLoss = Math.max(longestLoss, run);
    unbeatenRun = g.loss ? 0 : unbeatenRun + 1;
    longestUnbeaten = Math.max(longestUnbeaten, unbeatenRun);

    // `>=` / `<=` so ties resolve to the most recent game
    if (g.win && g.margin > 0 && (!biggestWin || g.margin >= biggestWin.margin)) biggestWin = g;
    if (!closest || Math.abs(g.margin) <= Math.abs(closest.margin)) closest = g;
    if (!mostGoals || g.myScore + g.oppScore >= mostGoals.myScore + mostGoals.oppScore) mostGoals = g;
  }
  const losses = total - wins - draws;

  return {
    total,
    wins,
    draws,
    losses,
    pct: wins / total,
    points: wins * 3 + draws, // FIFA: 3 for a win, 1 for a draw
    ppg: (wins * 3 + draws) / total,
    streak: { result: runResult, win: runResult === 'W', count: run },
    longestWin,
    longestLoss,
    longestUnbeaten,
    avgFor: pointsFor / total,
    avgAgainst: pointsAgainst / total,
    avgMargin: (pointsFor - pointsAgainst) / total,
    goalsFor: pointsFor,
    goalsAgainst: pointsAgainst,
    goalDiff: pointsFor - pointsAgainst,
    cleanSheets,
    oppCleanSheets,
    biggestWin,
    closest,
    mostGoals,
    last5: list.slice(-5).map((g) => g.win), // oldest → newest
    latest: list.at(-1),
  };
}

/** Wins/draws/losses for a subset of perspective views (e.g. one month). */
export function record(viewList) {
  const wins = viewList.filter((g) => g.win).length;
  const draws = viewList.filter((g) => g.draw).length;
  return { wins, draws, losses: viewList.length - wins - draws };
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

/**
 * One point per game, oldest → newest, from `playerId`'s side:
 *   lead    – net wins so far (wins − losses; draws count for neither).
 *   winPct  – win percentage so far.
 * `t` is a timestamp: the game's date, with same-day games spread across that day in play order.
 */
export function timeline(games, playerId) {
  const list = views(games, playerId).reverse();
  const perDay = new Map();
  list.forEach((g) => perDay.set(g.date, (perDay.get(g.date) || 0) + 1));
  const seen = new Map();
  let wins = 0, losses = 0;
  return list.map((g, i) => {
    if (g.win) wins++;
    if (g.loss) losses++;
    const k = seen.get(g.date) || 0;
    seen.set(g.date, k + 1);
    const [y, m, d] = g.date.split('-').map(Number);
    const t = new Date(y, m - 1, d).getTime() + ((k + 1) / (perDay.get(g.date) + 1)) * 86400000;
    return { t, game: g, lead: wins - losses, winPct: (wins / (i + 1)) * 100 };
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
    const r = by.get(g[key]) || { abbr: g[key], wins: 0, draws: 0, losses: 0 };
    tally(r, g);
    by.set(g[key], r);
  }
  return [...by.values()]
    .map((r) => ({ ...r, games: r.wins + r.draws + r.losses, pct: r.wins / (r.wins + r.draws + r.losses) }))
    .sort((a, b) => b.games - a.games || b.pct - a.pct || a.abbr.localeCompare(b.abbr));
}

const tally = (r, g) => (g.win ? r.wins++ : g.draw ? r.draws++ : r.losses++);

export const CLOSE_MARGIN = 5;
export const BLOWOUT_MARGIN = 15;

/** Which games each Clutch cell counts. 2K: close (≤5), overtime, blowouts (15+). FIFA: 1-goal games, shootouts, clean sheets. */
export const CLUTCH_TESTS = {
  close: (g) => Math.abs(g.margin) <= CLOSE_MARGIN,
  overtime: (g) => g.overtime,
  blowouts: (g) => Math.abs(g.margin) >= BLOWOUT_MARGIN,
  oneGoal: (g) => Math.abs(g.margin) === 1,
  shootouts: (g) => g.shootout,
  cleanSheets: (g) => g.oppScore === 0 || g.myScore === 0,
};

export function clutch(viewList) {
  const rec = (test) => record(viewList.filter(test));
  return {
    close: rec(CLUTCH_TESTS.close),
    overtime: rec(CLUTCH_TESTS.overtime),
    blowouts: rec(CLUTCH_TESTS.blowouts),
    oneGoal: rec(CLUTCH_TESTS.oneGoal),
    shootouts: rec(CLUTCH_TESTS.shootouts),
    cleanSheets: { mine: viewList.filter((g) => g.oppScore === 0).length, theirs: viewList.filter((g) => g.myScore === 0).length },
  };
}

/** Games per calendar day: Map 'YYYY-MM-DD' → { wins, draws, losses }. */
export function activityByDay(viewList) {
  const days = new Map();
  for (const g of viewList) {
    const d = days.get(g.date) || { wins: 0, draws: 0, losses: 0 };
    tally(d, g);
    days.set(g.date, d);
  }
  return days;
}

/** Record against each opponent (for a profile). `viewList` is from the profile owner's side. */
export function opponentRecords(viewList) {
  const by = new Map();
  for (const g of viewList) {
    const r = by.get(g.oppId) || { id: g.oppId, wins: 0, draws: 0, losses: 0, last: g.date };
    tally(r, g);
    if (g.date > r.last) r.last = g.date;
    by.set(g.oppId, r);
  }
  return [...by.values()].map((r) => ({ ...r, games: r.wins + r.draws + r.losses })).sort((a, b) => b.games - a.games || b.last.localeCompare(a.last));
}
