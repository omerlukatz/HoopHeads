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
